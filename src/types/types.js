/* @flow */

import {
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLID,
  GraphQLObjectType,
  GraphQLNonNull,
  GraphQLInterfaceType,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLList
} from 'graphql'

import {
  connectionDefinitions,
  connectionArgs,
  connectionFromArray,
  toGlobalId,
  fromGlobalId
} from 'graphql-relay'

import {
  mapArrayToObject
} from '../utils/array.js'

import {
  mergeObjects
} from '../utils/object.js'

import {
  isScalar,
  convertInputFieldsToInternalIds,
  externalIdFromQueryInfo,
  parseValue
} from '../utils/graphql.js'

import type {
  ClientSchema,
  ClientSchemaField,
  ClientTypes,
  AllTypes,
  GraphQLFields,
  SchemaType
} from '../utils/definitions.js'

function getFilterPairsFromFilterArgument (filter) {
  if (!filter) {
    return []
  }

  var filters = []
  for (const field in filter) {
    if (filter[field] != null) {
      filters.push({ field, value: filter[field] })
    }
  }

  return filters
}

function injectRelationships (
  objectType: GraphQLObjectType,
  clientSchema: ClientSchema,
  allClientTypes: ClientTypes
): void {
  const objectTypeFields = objectType._typeConfig.fields

  clientSchema.fields
    .filter((field) => objectTypeFields[field.fieldName].type.__isRelation)
    .forEach((clientSchemaField: ClientSchemaField) => {
      const fieldName = clientSchemaField.fieldName
      const objectTypeField = objectTypeFields[fieldName]
      const typeIdentifier = objectTypeField.type.typeIdentifier

      // 1:n relationship
      if (clientSchemaField.isList) {
        const connectionType = allClientTypes[typeIdentifier].connectionType
        objectTypeField.type = connectionType
        objectTypeField.args = allClientTypes[typeIdentifier].queryFilterInputArguments
        objectTypeField.resolve = (obj, args, { operation, rootValue: { backend, currentUser } }) => (
          backend.allNodesByRelation(
            clientSchema.modelName,
            obj.id,
            fieldName,
            args,
            allClientTypes[typeIdentifier].clientSchema,
            currentUser,
            operation)
          .then((array) => {
            if (args.filter) {
              args.filter = convertInputFieldsToInternalIds(args.filter, allClientTypes[typeIdentifier].clientSchema)
              array = array.filter((x) =>
                getFilterPairsFromFilterArgument(args.filter)
                .every((filter) => x[filter.field] === filter.value))
            }

            const { edges, pageInfo } = connectionFromArray(array, args)

            return {
              edges,
              pageInfo,
              totalCount: array.length
            }
          }).catch(console.log)
        )
      // 1:1 relationship
      } else {
        objectTypeField.type = allClientTypes[typeIdentifier].objectType
        objectTypeField.resolve = (obj, args, { operation, rootValue: { backend, currentUser } }) => (
          obj[`${fieldName}Id`]
          ? backend.node(
              typeIdentifier,
              obj[`${fieldName}Id`],
              allClientTypes[typeIdentifier].clientSchema,
              currentUser,
              operation)
          : null
        )
      }
    })
}

function wrapWithNonNull (
  objectType: GraphQLObjectType,
  clientSchema: ClientSchema
): void {
  clientSchema.fields
    .filter((field) => field.isRequired)
    .forEach((clientSchemaField: ClientSchemaField) => {
      const fieldName = clientSchemaField.fieldName
      const objectTypeField = objectType._typeConfig.fields[fieldName]
      objectTypeField.type = new GraphQLNonNull(objectTypeField.type)
    })
}

export function createTypes (clientSchemas: Array<ClientSchema>, schemaType: SchemaType): AllTypes {
  const enumTypes = {}
  function parseClientType (field: ClientSchemaField, modelName: string) {
    switch (field.typeIdentifier) {
      case 'String': return GraphQLString
      case 'Boolean': return GraphQLBoolean
      case 'Int': return GraphQLInt
      case 'Float': return GraphQLFloat
      case 'GraphQLID': return GraphQLID
      case 'Password': return GraphQLString
      case 'Enum' :
        const enumTypeName = `${modelName}_${field.fieldName}`
        if (!enumTypes[enumTypeName]) {
          enumTypes[enumTypeName] = new GraphQLEnumType({
            name: enumTypeName,
            values: mapArrayToObject(field.enumValues, (x) => x, (x) => ({value: x}))
          })
        }

        return enumTypes[enumTypeName]
      // NOTE this marks a relation type which will be overwritten by `injectRelationships`
      default: return { __isRelation: true, typeIdentifier: field.typeIdentifier }
    }
  }

  function getValueOrDefault (obj, field) {
    return obj[field.fieldName] || (field.defaultValue ? parseValue(field.defaultValue, field.typeIdentifier) : null)
  }

  function generateObjectType (
    clientSchema: ClientSchema,
    NodeInterfaceType: GraphQLInterfaceType
  ): GraphQLObjectType {
    const graphQLFields: GraphQLFields = mapArrayToObject(
      clientSchema.fields,
      (field) => field.fieldName,
      (field) => {
        const type = parseClientType(field, clientSchema.modelName)
        const resolve = field.fieldName === 'id'
          ? (obj) => toGlobalId(clientSchema.modelName, getValueOrDefault(obj, field))
          : (obj) => getValueOrDefault(obj, field)

        return {type, resolve}
      }
    )

    return new GraphQLObjectType({
      name: clientSchema.modelName,
      fields: graphQLFields,
      interfaces: [NodeInterfaceType]
    })
  }

  function generateObjectMutationInputArguments (
    clientSchema: ClientSchema,
    scalarFilter: (field: ClientSchemaField) => boolean,
    oneToOneFilter: (field: ClientSchemaField) => boolean,
    forceFieldsOptional: boolean = false,
    forceIdFieldOptional: boolean = false
  ): GraphQLObjectType {
    const scalarFields = clientSchema.fields.filter(scalarFilter)
    const scalarArguments = mapArrayToObject(
      scalarFields,
      (field) => field.fieldName,
      (field) => ({
        type: (field.isRequired && !(forceFieldsOptional && (forceIdFieldOptional || field.fieldName !== 'id')))
          ? new GraphQLNonNull(parseClientType(field, clientSchema.modelName))
          : parseClientType(field, clientSchema.modelName)
      })
    )

    const onetoOneFields = clientSchema.fields.filter(oneToOneFilter)
    const oneToOneArguments = mapArrayToObject(
      onetoOneFields,
      (field) => `${field.fieldName}Id`,
      (field) => ({
        type: (field.isRequired && !forceFieldsOptional) ? new GraphQLNonNull(GraphQLID) : GraphQLID
      }))

    return mergeObjects(scalarArguments, oneToOneArguments)
  }

  function generateCreateObjectMutationInputArguments (
    clientSchema: ClientSchema
  ): GraphQLObjectType {
    return generateObjectMutationInputArguments(
      clientSchema,
      (field) => !parseClientType(field, clientSchema.modelName).__isRelation && field.fieldName !== 'id',
      (field) => parseClientType(field, clientSchema.modelName).__isRelation && !field.isList,
      false
    )
  }

  function generateUpdateObjectMutationInputArguments (
    clientSchema: ClientSchema
  ): GraphQLObjectType {
    return generateObjectMutationInputArguments(
      clientSchema,
      (field) => !parseClientType(field, clientSchema.modelName).__isRelation,
      (field) => parseClientType(field, clientSchema.modelName).__isRelation && !field.isList,
      true
    )
  }

  const simpleConnectionArgs = {
    skip: {
      type: GraphQLInt
    },
    take: {
      type: GraphQLInt
    }
  }

  function generateQueryFilterInputArguments (
    clientSchema: ClientSchema
  ): GraphQLObjectType {
    const args = generateObjectMutationInputArguments(
      clientSchema,
      (field) => !parseClientType(field, clientSchema.modelName).__isRelation,
      (field) => parseClientType(field, clientSchema.modelName).__isRelation && !field.isList,
      true,
      true
    )

    return mergeObjects(
      schemaType === 'RELAY' ? connectionArgs : simpleConnectionArgs,
      {
        filter: {
          type: new GraphQLInputObjectType({
            name: `${clientSchema.modelName}Filter`,
            fields: args
          })
        },
        orderBy: {
          type: generateQueryOrderByEnum(clientSchema)
        }
      }
    )
  }

  function generateQueryOrderByEnum (
    clientSchema: ClientSchema
  ): GraphQLEnumType {
    const values = []
    clientSchema.fields.filter((field) => isScalar(field.typeIdentifier)).forEach((field) => {
      values.push(`${field.fieldName}_ASC`)
      values.push(`${field.fieldName}_DESC`)
    })
    return new GraphQLEnumType({
      name: `${clientSchema.modelName}SortBy`,
      values: mapArrayToObject(values, (x) => x, (x) => ({value: x}))
    })
  }

  const clientTypes: ClientTypes = {}

  const NodeInterfaceType = new GraphQLInterfaceType({
    name: 'NodeInterface',
    fields: () => ({
      id: { type: GraphQLID }
    }),
    resolveType: (node, info) => {
      const externalId = externalIdFromQueryInfo(info)
      const {type} = fromGlobalId(externalId)
      return clientTypes[type].objectType
    }
  })

  // generate object types without relationships properties since we need all of the object types first
  mapArrayToObject(
    clientSchemas,
    (clientSchema) => clientSchema.modelName,
    (clientSchema) => {
      const objectType = generateObjectType(clientSchema, NodeInterfaceType)
      const { connectionType, edgeType } = connectionDefinitions({
        name: clientSchema.modelName,
        nodeType: objectType,
        connectionFields: () => ({
          totalCount: {
            type: GraphQLInt,
            resolve: (conn) => conn.totalCount
          }
        })
      })
      const createMutationInputArguments = generateCreateObjectMutationInputArguments(clientSchema)
      const updateMutationInputArguments = generateUpdateObjectMutationInputArguments(clientSchema)
      const queryFilterInputArguments = generateQueryFilterInputArguments(clientSchema)
      return {
        clientSchema,
        objectType,
        connectionType,
        edgeType,
        createMutationInputArguments,
        updateMutationInputArguments,
        queryFilterInputArguments
      }
    },
    clientTypes
  )

  // set relationship properties
  for (const modelName in clientTypes) {
    injectRelationships(
      clientTypes[modelName].objectType,
      clientTypes[modelName].clientSchema,
      clientTypes
    )
  }

  // set nullable properties
  for (const modelName in clientTypes) {
    wrapWithNonNull(
      clientTypes[modelName].objectType,
      clientTypes[modelName].clientSchema
    )
  }

  const viewerFields = {}
  for (const modelName in clientTypes) {
    viewerFields[`all${modelName}s`] = {
      type: schemaType === 'RELAY'
        ? clientTypes[modelName].connectionType
        : new GraphQLList(clientTypes[modelName].objectType),
      args: clientTypes[modelName].queryFilterInputArguments,
      resolve: (_, args, { operation, rootValue: { currentUser, backend } }) => (
        backend.allNodesByType(modelName, args, clientTypes[modelName].clientSchema, currentUser, operation)
          .then((array) => {
            if (args.filter) {
              args.filter = convertInputFieldsToInternalIds(args.filter, clientTypes[modelName].clientSchema)
              array = array.filter((x) =>
                getFilterPairsFromFilterArgument(args.filter)
                .every((filter) => x[filter.field] === filter.value))
            }

            // todo: how should orderBy work with other types than string and number ?
            if (args.orderBy) {
              const order = args.orderBy.indexOf('_DESC') > -1 ? 'DESC' : 'ASC'
              const fieldName = args.orderBy.split(`_${order}`)[0]
              if (order === 'DESC') {
                array = array.sort((a, b) => {
                  return ((typeof a[fieldName]) === 'string')
                  ? b[fieldName].toLowerCase().localeCompare(a[fieldName].toLowerCase())
                  : b[fieldName] - a[fieldName]
                })
              } else {
                array = array.sort((a, b) => {
                  return ((typeof a[fieldName]) === 'string')
                  ? a[fieldName].toLowerCase().localeCompare(b[fieldName].toLowerCase())
                  : a[fieldName] - b[fieldName]
                })
              }
            }

            if (schemaType === 'RELAY') {
              const { edges, pageInfo } = connectionFromArray(array, args)
              return {
                edges,
                pageInfo,
                totalCount: array.length
              }
            } else {
              const skip = args.skip || 0
              const take = args.take || array.length

              return array.slice(skip, skip + take)
            }
          })
      )
    }
  }

  viewerFields.id = {
    type: GraphQLID,
    resolve: (obj) => toGlobalId('User', obj.id)
  }

  if (clientTypes.User) {
    viewerFields.user = {
      type: clientTypes.User.objectType,
      resolve: (_, args, { rootValue: { backend } }) => (
        backend.user()
      )
    }
  }

  const viewerType = new GraphQLObjectType({
    name: 'Viewer',
    fields: viewerFields,
    interfaces: [NodeInterfaceType]
  })

  return {clientTypes, NodeInterfaceType, viewerType, viewerFields}
}
