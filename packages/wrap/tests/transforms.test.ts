import {
  GraphQLSchema,
  GraphQLScalarType,
  graphql,
  Kind,
  SelectionSetNode,
} from 'graphql';

import { makeExecutableSchema } from '@graphql-tools/schema';

import {
  wrapSchema,
  WrapQuery,
  ExtractField,
  TransformQuery,
} from '@graphql-tools/wrap';

import {
  delegateToSchema,
  defaultMergedResolver,
} from '@graphql-tools/delegate';

function createError<T>(message: string, extra?: T) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error as Error & T;
}

describe('transforms', () => {
  describe('base transform function', () => {
    const scalarTest = `
      scalar TestScalar
      type TestingScalar {
        value: TestScalar
      }

      type Query {
        testingScalar(input: TestScalar): TestingScalar
      }
    `;

    const scalarSchema = makeExecutableSchema({
      typeDefs: scalarTest,
      resolvers: {
        TestScalar: new GraphQLScalarType({
          name: 'TestScalar',
          description: undefined,
          serialize: (value) => (value as string).slice(1),
          parseValue: (value) => `_${value as string}`,
          parseLiteral: (ast: any) => `_${ast.value as string}`,
        }),
        Query: {
          testingScalar(_parent, args) {
            return {
              value: args.input[0] === '_' ? args.input : null,
            };
          },
        },
      },
    });

    test('should work', async () => {
      const schema = wrapSchema({ schema: scalarSchema });
      const result = await graphql(
        schema,
        `
          query($input: TestScalar) {
            testingScalar(input: $input) {
              value
            }
          }
        `,
        {},
        {},
        {
          input: 'test',
        },
      );

      expect(result).toEqual({
        data: {
          testingScalar: {
            value: 'test',
          },
        },
      });
    });

    test('should work when specified as a subschema configuration object', async () => {
      const schema = wrapSchema({
        schema: scalarSchema,
        transforms: [],
      });
      const result = await graphql(
        schema,
        `
          query($input: TestScalar) {
            testingScalar(input: $input) {
              value
            }
          }
        `,
        {},
        {},
        {
          input: 'test',
        },
      );

      expect(result).toEqual({
        data: {
          testingScalar: {
            value: 'test',
          },
        },
      });
    });

    test('should not change error type', async () => {
      const customError = createError('TestError', {
        data: { code: '123' },
        message: 'TestError Error',
      });

      const subschema = makeExecutableSchema({
        typeDefs: `
          type Query {
            errorTest: String
          }
        `,
        resolvers: {
          Query: {
            errorTest: () => customError,
          },
        },
      });
      const schema = wrapSchema({ schema: subschema });

      const query = 'query { errorTest }';
      const originalResult = await graphql(subschema, query);
      const transformedResult = await graphql(schema, query);
      expect(originalResult).toEqual(transformedResult);
    });
  });

  describe('tree operations', () => {
    let data: any;
    let subschema: GraphQLSchema;
    let schema: GraphQLSchema;
    beforeAll(() => {
      data = {
        u1: {
          id: 'u1',
          username: 'alice',
          address: {
            streetAddress: 'Windy Shore 21 A 7',
            zip: '12345',
          },
        },
        u2: {
          id: 'u2',
          username: 'bob',
          address: {
            streetAddress: 'Snowy Mountain 5 B 77',
            zip: '54321',
          },
        },
      };
      subschema = makeExecutableSchema({
        typeDefs: `
        type User {
          id: ID!
          username: String
          address: Address
        }

        type Address {
          streetAddress: String
          zip: String
        }

        input UserInput {
          id: ID!
          username: String
        }

        input AddressInput {
          id: ID!
          streetAddress: String
          zip: String
        }

        type Query {
          userById(id: ID!): User
        }

        type Mutation {
          setUser(input: UserInput!): User
          setAddress(input: AddressInput!): Address
        }
      `,
        resolvers: {
          Query: {
            userById(_parent, { id }) {
              return data[id];
            },
          },
          Mutation: {
            setUser(_parent, { input }) {
              if (data[input.id]) {
                return {
                  ...data[input.id],
                  ...input,
                };
              }
            },
            setAddress(_parent, { input }) {
              if (data[input.id]) {
                return {
                  ...data[input.id].address,
                  ...input,
                };
              }
            },
          },
        },
      });
      schema = makeExecutableSchema({
        typeDefs: `
        type User {
          id: ID!
          username: String
          address: Address
        }

        type Address {
          streetAddress: String
          zip: String
        }

        input UserInput {
          id: ID!
          username: String
          streetAddress: String
          zip: String
        }

        type Query {
          addressByUser(id: ID!): Address
        }

        type Mutation {
          setUserAndAddress(input: UserInput!): User
        }
      `,
        resolvers: {
          Query: {
            addressByUser(_parent, { id }, context, info) {
              return delegateToSchema({
                schema: subschema,
                operation: 'query',
                fieldName: 'userById',
                args: { id },
                context,
                info,
                transforms: [
                  // Wrap document takes a subtree as an AST node
                  new WrapQuery(
                    // path at which to apply wrapping and extracting
                    ['userById'],
                    (subtree: SelectionSetNode) => ({
                      // we create a wrapping AST Field
                      kind: Kind.FIELD,
                      name: {
                        kind: Kind.NAME,
                        // that field is `address`
                        value: 'address',
                      },
                      // Inside the field selection
                      selectionSet: subtree,
                    }),
                    // how to process the data result at path
                    (result) => result?.address,
                  ),
                ],
              });
            },
          },
          Mutation: {
            async setUserAndAddress(_parent, { input }, context, info) {
              const addressResult = await delegateToSchema({
                schema: subschema,
                operation: 'mutation',
                fieldName: 'setAddress',
                args: {
                  input: {
                    id: input.id,
                    streetAddress: input.streetAddress,
                    zip: input.zip,
                  },
                },
                context,
                info,
                transforms: [
                  // ExtractField takes a path from which to extract the query
                  // for delegation and path to which to move it
                  new ExtractField({
                    from: ['setAddress', 'address'],
                    to: ['setAddress'],
                  }),
                ],
              });
              const userResult = await delegateToSchema({
                schema: subschema,
                operation: 'mutation',
                fieldName: 'setUser',
                args: {
                  input: {
                    id: input.id,
                    username: input.username,
                  },
                },
                context,
                info,
              });
              return {
                ...userResult,
                address: addressResult,
              };
            },
          },
        },
      });
    });

    test('wrapping delegation', async () => {
      const result = await graphql(
        schema,
        `
          query {
            addressByUser(id: "u1") {
              streetAddress
              zip
            }
          }
        `,
      );

      expect(result).toEqual({
        data: {
          addressByUser: {
            streetAddress: 'Windy Shore 21 A 7',
            zip: '12345',
          },
        },
      });
    });

    test('extracting delegation', async () => {
      const result = await graphql(
        schema,
        `
          mutation($input: UserInput!) {
            setUserAndAddress(input: $input) {
              username
              address {
                zip
                streetAddress
              }
            }
          }

          # fragment UserFragment on User {
          #   address {
          #     zip
          #     ...AddressFragment
          #   }
          # }
          #
          # fragment AddressFragment on Address {
          #   streetAddress
          # }
        `,
        {},
        {},
        {
          input: {
            id: 'u2',
            username: 'new-username',
            streetAddress: 'New Address 555',
            zip: '22222',
          },
        },
      );
      expect(result).toEqual({
        data: {
          setUserAndAddress: {
            username: 'new-username',
            address: {
              streetAddress: 'New Address 555',
              zip: '22222',
            },
          },
        },
      });
    });
  });

  describe('TransformQuery', () => {
    let data: any;
    let subschema: GraphQLSchema;
    let schema: GraphQLSchema;
    beforeAll(() => {
      data = {
        u1: {
          id: 'u1',
          username: 'alice',
          address: {
            streetAddress: 'Windy Shore 21 A 7',
            zip: '12345',
          },
        },
        u2: {
          id: 'u2',
          username: 'bob',
          address: {
            streetAddress: 'Snowy Mountain 5 B 77',
            zip: '54321',
          },
        },
      };
      subschema = makeExecutableSchema({
        typeDefs: `
          type User {
            id: ID!
            username: String
            address: Address
            errorTest: Address
          }

          type Address {
            streetAddress: String
            zip: String
            errorTest: String
          }

          type Query {
            userById(id: ID!): User
          }
        `,
        resolvers: {
          User: {
            errorTest: () => {
              throw new Error('Test Error!');
            },
          },
          Address: {
            errorTest: () => {
              throw new Error('Test Error!');
            },
          },
          Query: {
            userById(_parent, { id }) {
              return data[id];
            },
          },
        },
      });
      schema = makeExecutableSchema({
        typeDefs: `
          type Address {
            streetAddress: String
            zip: String
            errorTest: String
          }

          type Query {
            addressByUser(id: ID!): Address
            errorTest(id: ID!): Address
          }
        `,
        resolvers: {
          Query: {
            addressByUser(_parent, { id }, context, info) {
              return delegateToSchema({
                schema: subschema,
                operation: 'query',
                fieldName: 'userById',
                args: { id },
                context,
                info,
                transforms: [
                  // Wrap document takes a subtree as an AST node
                  new TransformQuery({
                    // path at which to apply wrapping and extracting
                    path: ['userById'],
                    queryTransformer: (subtree: SelectionSetNode) => ({
                      kind: Kind.SELECTION_SET,
                      selections: [
                        {
                          // we create a wrapping AST Field
                          kind: Kind.FIELD,
                          name: {
                            kind: Kind.NAME,
                            // that field is `address`
                            value: 'address',
                          },
                          // Inside the field selection
                          selectionSet: subtree,
                        },
                      ],
                    }),
                    // how to process the data result at path
                    resultTransformer: (result) => result?.address,
                    errorPathTransformer: (path) => path.slice(1),
                  }),
                ],
              });
            },
            errorTest(_parent, { id }, context, info) {
              return delegateToSchema({
                schema: subschema,
                operation: 'query',
                fieldName: 'userById',
                args: { id },
                context,
                info,
                transforms: [
                  new TransformQuery({
                    path: ['userById'],
                    queryTransformer: (subtree: SelectionSetNode) => ({
                      kind: Kind.SELECTION_SET,
                      selections: [
                        {
                          kind: Kind.FIELD,
                          name: {
                            kind: Kind.NAME,
                            value: 'errorTest',
                          },
                          selectionSet: subtree,
                        },
                      ],
                    }),
                    resultTransformer: (result) => result?.address,
                    errorPathTransformer: (path) => path.slice(1),
                  }),
                ],
              });
            },
          },
        },
      });
    });

    test('wrapping delegation', async () => {
      const result = await graphql(
        schema,
        `
          query {
            addressByUser(id: "u1") {
              streetAddress
              zip
            }
          }
        `,
      );

      expect(result).toEqual({
        data: {
          addressByUser: {
            streetAddress: 'Windy Shore 21 A 7',
            zip: '12345',
          },
        },
      });
    });

    test('preserves errors from underlying fields', async () => {
      const result = await graphql(
        schema,
        `
          query {
            addressByUser(id: "u1") {
              errorTest
            }
          }
        `,
        {},
        {},
        {},
        undefined,
        defaultMergedResolver,
      );

      expect(result).toEqual({
        data: {
          addressByUser: {
            errorTest: null,
          },
        },
        errors: [
          {
            locations: [
              {
                column: 15,
                line: 4,
              },
            ],
            message: 'Test Error!',
            path: ['addressByUser', 'errorTest'],
          },
        ],
      });
    });

    test('preserves errors when delegating from a root field to an error', async () => {
      const result = await graphql(
        schema,
        `
          query {
            errorTest(id: "u1") {
              errorTest
            }
          }
        `,
        {},
        {},
        {},
        undefined,
        defaultMergedResolver,
      );

      expect(result).toEqual({
        data: {
          errorTest: null,
        },
        errors: [new Error('Test Error!')],
      });
    });
  });
});
