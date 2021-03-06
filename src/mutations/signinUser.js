/* @flow */

import type {
  SchemaType
} from '../utils/definitions.js'

import simpleMutation from './simpleMutation.js'

import {
  GraphQLNonNull,
  GraphQLString,
  GraphQLObjectType
} from 'graphql'

import {
  mutationWithClientMutationId
} from 'graphql-relay'

export default function (
  viewerType: GraphQLObjectType, schemaType: SchemaType
  ): GraphQLObjectType {
  const config = {
    name: 'SigninUser',
    outputFields: {
      token: {
        type: GraphQLString
      },
      viewer: {
        type: viewerType
      }
    },
    inputFields: {
      email: {
        type: new GraphQLNonNull(GraphQLString)
      },
      password: {
        type: new GraphQLNonNull(GraphQLString)
      }
    },
    mutateAndGetPayload: (args, { rootValue: { backend } }) => (
      // todo: efficiently get user by email
      backend.NO_PERMISSION_CHECK_allNodesByType('User')
      .then((allUsers) => allUsers.filter((node) => node.email === args.email)[0])
      .then((user) =>
        !user
        ? Promise.reject(`no user with the email '${args.email}'`)
        : backend.compareHashAsync(args.password, user.password)
          .then((result) =>
            !result
            ? Promise.reject(`incorrect password for email '${args.email}'`)
            : user
          )
      )
      .then((user) => ({
        token: backend.tokenForUser(user),
        viewer: {
          id: user.id
        }
      }))
    )
  }

  if (schemaType === 'SIMPLE') {
    return simpleMutation(config,
      new GraphQLObjectType({
        name: 'SigninUserPayload',
        fields: {
          token: {
            type: new GraphQLNonNull(GraphQLString)
          }
        }
      }),
      (root) => ({token: root.token}))
  } else {
    return mutationWithClientMutationId(config)
  }
}
