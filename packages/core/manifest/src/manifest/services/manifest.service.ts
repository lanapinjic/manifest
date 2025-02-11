import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { SchemaService } from './schema.service'
import { YamlService } from './yaml.service'
import { AUTHENTICABLE_PROPS, DEFAULT_IMAGE_SIZES } from '../../constants'

import {
  AppManifest,
  Manifest,
  EntityManifest,
  EntitySchema,
  PolicyManifest,
  PropType,
  PropertyManifest,
  PropertySchema,
  RelationshipSchema,
  AccessPolicy,
  RelationshipManifest,
  PolicySchema,
  ValidationManifest
} from '@repo/types'
import dasherize from 'dasherize'
import pluralize from 'pluralize'
import slugify from 'slugify'

import { ADMIN_ENTITY_MANIFEST, DEFAULT_SEED_COUNT } from '../../constants'
import { camelize } from '@repo/helpers'
import {
  adminAccessPolicy,
  forbiddenAccessPolicy,
  publicAccessPolicy
} from '../utils/policy-manifests'

@Injectable()
export class ManifestService {
  constructor(
    private yamlService: YamlService,
    private schemaService: SchemaService
  ) {}

  /**
   * Load the manifest from the file, validate it and transform it.
   *
   * @param publicVersion Whether to return the public version of the manifest.THe public version is the one that is exposed to the client: it hides settings and the hidden properties.
   *
   *
   * @returns The manifest.
   *
   * */
  getAppManifest(options?: { fullVersion?: boolean }): AppManifest {
    const manifestSchema: Manifest = this.yamlService.load()

    if (!manifestSchema.entities) {
      manifestSchema.entities = {}
    }

    this.schemaService.validate(manifestSchema)

    // Add Admin entity.
    manifestSchema.entities.Admin = ADMIN_ENTITY_MANIFEST

    const appManifest: AppManifest = {
      ...manifestSchema,
      version: manifestSchema.version || '0.0.1',
      entities: this.transformEntityManifests(manifestSchema.entities).reduce(
        (acc, entityManifest: EntityManifest) => {
          acc[entityManifest.className] = entityManifest
          return acc
        },
        {}
      )
    }

    // Add the Admin entity to the manifest.
    manifestSchema.entities.Admin = ADMIN_ENTITY_MANIFEST

    if (!options?.fullVersion) {
      return this.hideSensitiveInformation(appManifest)
    }
    return appManifest
  }

  /**
   * Load the entities from the manifest and fill in the defaults.
   *
   * @returns The entity manifests.
   *
   * */
  getEntityManifests(): EntityManifest[] {
    const manifestSchema: Manifest = this.yamlService.load()

    if (!manifestSchema.entities) {
      manifestSchema.entities = {}
    }

    // Add Admin entity.
    manifestSchema.entities.Admin = ADMIN_ENTITY_MANIFEST

    return this.transformEntityManifests(manifestSchema.entities)
  }

  /**
   * Load a single entity from the manifest and fill in the defaults.
   *
   * @param className The class name of the entity to load.
   * @param slug The slug of the entity to load.
   *
   * @returns The entity manifest.
   *
   * */
  getEntityManifest({
    className,
    slug,
    fullVersion
  }: {
    className?: string
    slug?: string
    fullVersion?: boolean
  }): EntityManifest {
    if (!className && !slug) {
      throw new HttpException(
        `Either className or slug must be provided`,
        HttpStatus.BAD_REQUEST
      )
    }

    const entities: EntityManifest[] = this.getEntityManifests()

    let entityManifest: EntityManifest

    if (className) {
      entityManifest = entities.find((entity) => entity.className === className)
    } else {
      entityManifest = entities.find((entity) => entity.slug === slug)
    }

    if (!entityManifest) {
      throw new HttpException(
        `Entity ${className || slug} not found in manifest`,
        HttpStatus.NOT_FOUND
      )
    }

    if (!fullVersion) {
      return this.hideEntitySensitiveInformation(entityManifest)
    }

    return entityManifest
  }

  /**
   *
   * Transform an entityObject into an EntityManifest array ensuring that undefined properties are filled in with defaults
   * and short form properties are transformed into long form.
   *
   * @param an object with the class name as key and the EntitySchema as value.
   *
   * @returns the entity manifests with defaults filled in and short form properties transformed into long form.
   */
  transformEntityManifests(entitySchemaObject: {
    [keyof: string]: EntitySchema
  }): EntityManifest[] {
    const entityManifests: EntityManifest[] = Object.entries(
      entitySchemaObject
    ).map(([className, entitySchema]: [string, EntitySchema]) => {
      // Build the partial entity manifest with common properties of both collection and single entities.
      const partialEntityManifest: Partial<EntityManifest> = {
        className: entitySchema.className || className,
        nameSingular:
          entitySchema.nameSingular ||
          pluralize.singular(entitySchema.className || className).toLowerCase(),
        slug:
          entitySchema.slug ||
          slugify(
            dasherize(
              pluralize.plural(entitySchema.className || className)
            ).toLowerCase()
          ),
        single: entitySchema.single || false,
        properties: (entitySchema.properties || []).map(
          (propManifest: PropertySchema) =>
            this.transformProperty(propManifest, entitySchema)
        )
      }

      if (entitySchema.single) {
        return this.getSingleEntityManifestProps(
          partialEntityManifest,
          entitySchema
        )
      }

      return this.getCollectionEntityManifestProps(
        partialEntityManifest,
        entitySchema
      )
    })

    // Generate the OneToMany relationships from the opposite ManyToOne relationships.
    entityManifests.forEach((entityManifest: EntityManifest) => {
      if (entityManifest.single) return

      entityManifest.relationships.push(
        ...this.getOneToManyRelationships(entityManifests, entityManifest)
      )
    })

    // Generate the ManyToMany relationships from the opposite ManyToMany relationships.
    entityManifests.forEach((entityManifest: EntityManifest) => {
      if (entityManifest.single) return

      entityManifest.relationships.push(
        ...this.getOppositeManyToManyRelationships(
          entityManifests,
          entityManifest
        )
      )
    })

    return entityManifests
  }

  /**
   * Returns the entity manifest with the collection entity properties.
   *
   * @param partialEntityManifest the partial entity manifest.
   * @param entitySchema the entity schema to which the entity belongs.
   *
   * @returns the complete entity manifest with the collection entity properties.
   *
   */
  private getCollectionEntityManifestProps(
    partialEntityManifest: Partial<EntityManifest>,
    entitySchema: EntitySchema
  ): EntityManifest {
    if (entitySchema.authenticable) {
      partialEntityManifest.properties.push(...AUTHENTICABLE_PROPS)
    }

    return {
      ...partialEntityManifest,
      properties: partialEntityManifest.properties,
      namePlural:
        entitySchema.namePlural ||
        pluralize.plural(partialEntityManifest.className).toLowerCase(),
      mainProp:
        entitySchema.mainProp ||
        partialEntityManifest.properties.find(
          (prop) => prop.type === PropType.String
        )?.name ||
        'id',
      seedCount: entitySchema.seedCount || DEFAULT_SEED_COUNT,
      relationships: [
        ...(entitySchema.belongsTo || []).map(
          (relationship: RelationshipSchema) =>
            this.transformRelationship(relationship, 'many-to-one')
        ),
        ...(entitySchema.belongsToMany || []).map(
          (relationship: RelationshipSchema) =>
            this.transformRelationship(
              relationship,
              'many-to-many',
              partialEntityManifest.className
            )
        )
      ],
      authenticable: entitySchema.authenticable || false,
      policies: {
        create: this.transformPolicies(
          entitySchema.policies?.create,
          publicAccessPolicy
        ),
        read: this.transformPolicies(
          entitySchema.policies?.read,
          publicAccessPolicy
        ),
        update: this.transformPolicies(
          entitySchema.policies?.update,
          publicAccessPolicy
        ),
        delete: this.transformPolicies(
          entitySchema.policies?.delete,
          publicAccessPolicy
        ),
        signup: entitySchema.authenticable
          ? this.transformPolicies(
              entitySchema.policies?.signup,
              publicAccessPolicy
            )
          : [forbiddenAccessPolicy]
      }
    }
  }

  /**
   * Returns the entity manifest with the single entity properties.
   *
   * @param partialEntityManifest the partial entity manifest.
   * @param entitySchema the entity schema to which the entity belongs.
   *
   * @returns the complete entity manifest with the single entity properties.
   */
  private getSingleEntityManifestProps(
    partialEntityManifest: Partial<EntityManifest>,
    entitySchema: EntitySchema
  ): EntityManifest {
    return {
      ...partialEntityManifest,
      properties: partialEntityManifest.properties,
      relationships: [],
      policies: {
        create: [forbiddenAccessPolicy],
        read: this.transformPolicies(
          entitySchema.policies?.read,
          publicAccessPolicy
        ),
        update: this.transformPolicies(
          entitySchema.policies?.update,
          adminAccessPolicy
        ),
        delete: [forbiddenAccessPolicy],
        signup: [forbiddenAccessPolicy]
      }
    }
  }

  /**
   *
   * Transform the short form of the relationship into the long form.
   *
   * @param relationship the relationship that can include short form properties.
   * @param type the type of the relationship.
   * @param entityClassName the class name of the entity to which the relationship belongs (only for many-to-many relationships).
   *
   * @returns the relationship with the short form properties transformed into long form.
   */
  transformRelationship(
    relationship: RelationshipSchema,
    type: 'many-to-one' | 'many-to-many',
    entityClassName?: string
  ): RelationshipManifest {
    if (type === 'many-to-one') {
      if (typeof relationship === 'string') {
        return {
          name: camelize(relationship),
          entity: relationship,
          eager: false,
          type
        }
      }
      return {
        name: camelize(relationship.name || relationship.entity),
        entity: relationship.entity,
        eager: relationship.eager || false,
        type
      }
    } else {
      // Many-to-many.
      if (typeof relationship === 'string') {
        return {
          name: pluralize(camelize(relationship)),
          entity: relationship,
          eager: false,
          type,
          owningSide: true,
          inverseSide: pluralize(camelize(entityClassName))
        }
      }
      return {
        name: pluralize(camelize(relationship.name || relationship.entity)),
        entity: relationship.entity,
        eager: relationship.eager || false,
        type,
        owningSide: true,
        inverseSide: pluralize(camelize(entityClassName))
      }
    }
  }

  /**
   * Generate the OneToMany relationships from the opposite ManyToOne relationships.
   *
   * @param entityManifests The entity manifests.
   * @param currentEntityManifest The entity manifest for which to generate the OneToMany relationships.
   *
   * @returns The OneToMany relationships.
   */
  getOneToManyRelationships(
    entityManifests: EntityManifest[],
    currentEntityManifest: EntityManifest
  ): RelationshipManifest[] {
    // We need to get the entities that have ManyToOne relationships to the current entity to create the opposite OneToMany relationships.
    const oppositeRelationships: {
      entity: EntityManifest
      relationship: RelationshipManifest
    }[] = entityManifests
      .filter(
        (otherEntityManifest: EntityManifest) =>
          otherEntityManifest.className !== currentEntityManifest.className
      )
      .reduce((acc, otherEntityManifest: EntityManifest) => {
        const oppositeRelationship: RelationshipManifest =
          otherEntityManifest.relationships.find(
            (relationship: RelationshipManifest) =>
              relationship.entity === currentEntityManifest.className &&
              relationship.type === 'many-to-one'
          )

        if (oppositeRelationship) {
          acc.push({
            entity: otherEntityManifest,
            relationship: oppositeRelationship
          })
        }

        return acc
      }, [])

    return oppositeRelationships.map(
      (oppositeRelationship: {
        entity: EntityManifest
        relationship: RelationshipManifest
      }) => {
        const relationship: RelationshipManifest = {
          name: camelize(oppositeRelationship.entity.namePlural),
          entity: oppositeRelationship.entity.className,
          eager: false,
          type: 'one-to-many',
          inverseSide: oppositeRelationship.relationship.name
        }

        return relationship
      }
    )
  }

  /**
   * Generate the ManyToMany relationships from the opposite ManyToMany relationships.
   *
   * @param entityManifests The entity manifests.
   * @param currentEntityManifest The entity manifest for which to generate the ManyToMany relationships.
   *
   * @returns The ManyToMany relationships.
   */
  getOppositeManyToManyRelationships(
    entityManifests: EntityManifest[],
    currentEntityManifest: EntityManifest
  ): RelationshipManifest[] {
    // We need to get the entities that have ManyToMany relationships to the current entity to create the opposite ManyToMany relationships.
    const oppositeRelationships: {
      entity: EntityManifest
      relationship: RelationshipManifest
    }[] = entityManifests
      .filter(
        (otherEntityManifest: EntityManifest) =>
          otherEntityManifest.className !== currentEntityManifest.className
      )
      .reduce((acc, otherEntityManifest: EntityManifest) => {
        const oppositeRelationship: RelationshipManifest =
          otherEntityManifest.relationships.find(
            (relationship: RelationshipManifest) =>
              relationship.entity === currentEntityManifest.className &&
              relationship.type === 'many-to-many'
          )

        if (oppositeRelationship) {
          acc.push({
            entity: otherEntityManifest,
            relationship: oppositeRelationship
          })
        }

        return acc
      }, [])

    return oppositeRelationships.map(
      (oppositeRelationship: {
        entity: EntityManifest
        relationship: RelationshipManifest
      }) => {
        const relationship: RelationshipManifest = {
          name: pluralize(camelize(oppositeRelationship.entity.namePlural)),
          entity: oppositeRelationship.entity.className,
          eager: false,
          type: 'many-to-many',
          owningSide: false,
          inverseSide: oppositeRelationship.relationship.name
        }

        return relationship
      }
    )
  }

  /**
   *
   * Transform the short form of the property into the long form.
   *
   * @param propSchema the property that can be in short form.
   * @param entitySchema the entity schema to which the property belongs.
   *
   *
   * @returns the property with the short form properties transformed into long form.
   *
   */
  transformProperty(
    propSchema: PropertySchema,
    entitySchema: EntitySchema
  ): PropertyManifest {
    // Short syntax.
    if (typeof propSchema === 'string') {
      return {
        name: propSchema,
        type: PropType.String,
        hidden: false,
        validation:
          (entitySchema.validation?.[propSchema] as ValidationManifest) || {}
      }
    }

    return {
      name: propSchema.name,
      type: (propSchema.type as PropType) || PropType.String,
      hidden: propSchema.hidden || false,
      options:
        propSchema.options ||
        (propSchema.type === PropType.Image
          ? { sizes: DEFAULT_IMAGE_SIZES }
          : {}),
      validation: Object.assign(
        (entitySchema.validation?.[propSchema.name] as ValidationManifest) ||
          {},
        propSchema.validation
      )
    }
  }

  /**
   * Transform an array of short form policies of into an array of long form policies.
   *
   * @param policySchemas the policies that can be in short form.
   * @param defaultPolicy the default policy to use if the policy is not provided.
   *
   * @returns the policy with the short form properties transformed into long form.
   */
  transformPolicies(
    policySchemas: PolicySchema[],
    defaultPolicy: PolicyManifest
  ): PolicyManifest[] {
    if (!policySchemas) {
      return [defaultPolicy]
    }

    return policySchemas.map((policySchema: PolicySchema) => {
      let access: AccessPolicy

      // Transform emojis into long form.
      switch (policySchema.access) {
        case '🌐':
          access = 'public'
          break
        case '🔒':
          access = 'restricted'
          break
        case '️👨🏻‍💻':
          access = 'admin'
          break
        case '🚫':
          access = 'forbidden'
          break
        default:
          access = policySchema.access as AccessPolicy
      }

      const policyManifest: PolicyManifest = {
        access
      }

      if (policySchema.allow) {
        policyManifest.allow =
          typeof policySchema.allow === 'string'
            ? [policySchema.allow]
            : policySchema.allow
      }

      return policyManifest
    })
  }

  /**
   * Hide sensitive information from the manifest to be sent to the client.
   *
   * @param manifest The manifest to save.
   *
   * @returns The manifest with sensitive information hidden.
   *
   * */
  hideSensitiveInformation(manifest: AppManifest): AppManifest {
    return {
      ...manifest,
      entities: Object.entries(manifest.entities)
        .filter(
          ([className]: [string, EntitySchema]) =>
            className !== ADMIN_ENTITY_MANIFEST.className
        )
        .reduce(
          (
            acc: { [k: string]: EntityManifest },
            [className, entity]: [string, EntityManifest]
          ) => {
            const { ...publicEntity } = entity

            acc[className] = this.hideEntitySensitiveInformation(publicEntity)
            return acc
          },
          {}
        )
    }
  }

  /**
   * Hide entity sensitive information from the manifest to be sent to the client.
   *
   * @param entityManifest The entity manifest.
   *
   * @returns The entity manifest with sensitive information hidden.
   */
  hideEntitySensitiveInformation(
    entityManifest: EntityManifest
  ): EntityManifest {
    return {
      ...entityManifest,
      properties: entityManifest.properties
        .filter((prop) => !prop.hidden)
        .map((prop) => {
          delete prop.hidden
          return prop
        })
    }
  }
}
