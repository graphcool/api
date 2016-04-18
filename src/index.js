/* @flow */

import {
  GraphQLSchema,
  GraphQLObjectType
} from 'graphql'

import {
  createTypes
} from './types/types.js'

import {
  createQueryEndpoints
} from './queries/queries.js'

import {
  createMutationEndpoints
} from './mutations/mutations.js'

import type {
  ClientSchema,
  AllTypes,
  SchemaType
} from './utils/definitions.js'

export function generateSchema (clientSchemas: Array<ClientSchema>, schemaType: SchemaType = 'RELAY'): GraphQLSchema {
  // create types from client schemas
  const clientTypes: AllTypes = createTypes(clientSchemas, schemaType)

  // generate query endpoints
  const queryFields = createQueryEndpoints(clientTypes, schemaType)

  // generate mutation endpoints
  const mutationFields = createMutationEndpoints(clientTypes, schemaType)

  return new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'RootQueryType',
      fields: queryFields
    }),
    mutation: new GraphQLObjectType({
      name: 'RootMutationType',
      fields: mutationFields
    })
  })
}
