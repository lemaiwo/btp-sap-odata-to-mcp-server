import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SAPClient } from "../services/sap-client.js";
import { Logger } from "../utils/logger.js";
import { ODataService, EntityType } from "../types/sap-types.js";
import { z } from "zod";
import { createHash } from "node:crypto";

/**
 * To disable registration of specific entity tools, set the environment variable DISABLED_ENTITY_TOOLS
 * in your .env file. Format: ServiceId.EntityName,ServiceId.EntityName
 * Example: DISABLED_ENTITY_TOOLS=SALES_ORDER.OrderHeader,PRODUCT.ProductEntity
 * This will prevent registration of the ReadEntity tool for those entities.
 */

// Utility to check if ReadEntity tool registration is globally disabled
function isReadEntityToolDisabled(): boolean {
    return process.env.DISABLE_READ_ENTITY_TOOL === "true";
}

export class SAPToolRegistry {
    private toolNameMapping = new Map<string, string>();
    private usedShortNames = new Set<string>();

    constructor(private mcpServer: McpServer, private sapClient: SAPClient, private logger: Logger, private discoveredServices: ODataService[]) {}

    public registerServiceMetadataResources(): void {
        this.mcpServer.registerResource(
            "sap-service-metadata",
            new ResourceTemplate("sap://service/{serviceId}/metadata", { list: undefined }),
            {
                title: "SAP Service Metadata",
                description: "Metadata information for SAP OData services"
            },
            async (uri, variables) => {
                // variables: Record<string, unknown> from SDK
                const serviceId = typeof variables.serviceId === "string" ? variables.serviceId : "";
                const service = this.discoveredServices.find(s => s.id === serviceId);
                if (!service) {
                    throw new Error(`Service not found: ${serviceId}`);
                }
                return {
                    contents: [{
                        uri: uri.href,
                        text: JSON.stringify({
                            service: {
                                id: service.id,
                                title: service.title,
                                description: service.description,
                                url: service.url,
                                version: service.version
                            },
                            entities: service.metadata?.entityTypes?.map(entity => ({
                                name: entity.name,
                                entitySet: entity.entitySet,
                                properties: entity.properties,
                                keys: entity.keys,
                                operations: {
                                    creatable: entity.creatable,
                                    updatable: entity.updatable,
                                    deletable: entity.deletable
                                }
                            })) || []
                        }, null, 2),
                        mimeType: "application/json"
                    }]
                };
            }
        );
        this.mcpServer.registerResource(
            "sap-services",
            "sap://services",
            {
                title: "Available SAP Services",
                description: "List of all discovered SAP OData services",
                mimeType: "application/json"
            },
            async (uri) => ({
                contents: [{
                    uri: uri.href,
                    text: JSON.stringify({
                        services: this.discoveredServices.map(service => ({
                            id: service.id,
                            title: service.title,
                            description: service.description,
                            entityCount: service.metadata?.entityTypes?.length || 0
                        }))
                    }, null, 2)
                }]
            })
        );
    }

    public async registerServiceCRUDTools(): Promise<void> {
        const disableReadEntityTool = isReadEntityToolDisabled();
        for (const service of this.discoveredServices) {
            if (!service.metadata?.entityTypes) continue;
            for (const entityType of service.metadata.entityTypes) {
                this.registerReadEntitySetTool(service, entityType);
                // Only registerReadEntityTool if not globally disabled
                if (!disableReadEntityTool) {
                    this.registerReadEntityTool(service, entityType);
                }
                if (entityType.creatable) this.registerCreateEntityTool(service, entityType);
                if (entityType.updatable) this.registerUpdateEntityTool(service, entityType);
                if (entityType.deletable) this.registerDeleteEntityTool(service, entityType);
            }
        }
    }

    private registerReadEntitySetTool(service: ODataService, entityType: EntityType): void {
        const shortName = this.generateShortToolName('r', service.id, entityType.name);
        this.mcpServer.registerTool(
            shortName,
            {
                title: `List ${entityType.name} Entities`,
                description: `Read multiple ${entityType.name} entities from service '${service.title}' (${service.id}). ${service.description} Full identifier: read-entities--${service.id}--${entityType.name}`,
                inputSchema: {
                    filter: z.string().optional().describe('OData $filter query parameter for filtering results'),
                    select: z.string().optional().describe(`OData $select parameter. Available properties: ${entityType.properties.map(p => p.name).join(', ')}`),
                    expand: z.string().optional().describe('OData $expand parameter for related entities'),
                    orderby: z.string().optional().describe('OData $orderby parameter for sorting'),
                    top: z.number().optional().describe('OData $top parameter (limit number of results)'),
                    skip: z.number().optional().describe('OData $skip parameter (offset for pagination)')
                }
            },
            async (args: Record<string, unknown>) => {
                const queryOptions = SAPToolRegistry.buildQueryOptions(args);
                try {
                    const response = await this.sapClient.readEntitySet(
                        service.url,
                        entityType.entitySet!,
                        queryOptions
                    );
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify(response.data, null, 2)
                        }]
                    };
                } catch (error) {
                    this.logger.error(`Error reading entity set ${entityType.name}:`, error);
                    return {
                        content: [{
                            type: "text",
                            text: `Error: ${error instanceof Error ? error.message : String(error)}`
                        }],
                        isError: true
                    };
                }
            }
        );
    }

    private registerReadEntityTool(service: ODataService, entityType: EntityType): void {
        const keyProperties = entityType.properties.filter(p => entityType.keys.includes(p.name));
        const keySchema: { [key: string]: z.ZodTypeAny } = {};
        keyProperties.forEach(prop => {
            keySchema[prop.name] = this.getZodSchemaForODataType(prop.type).describe(`Key property: ${prop.name}`);
        });
        const shortName = this.generateShortToolName('rs', service.id, entityType.name);
        this.mcpServer.registerTool(
            shortName,
            {
                title: `Get ${entityType.name} Entity`,
                description: `Read a single ${entityType.name} entity from service '${service.title}' (${service.id}) by key properties: ${keyProperties.map(p => p.name).join(', ')}. Full identifier: read-entity--${service.id}--${entityType.name}`,
                inputSchema: keySchema
            },
            async (args: Record<string, unknown>) => {
                const keyValue = this.buildKeyValue(keyProperties, args);
                try {
                    const response = await this.sapClient.readEntity(
                        service.url,
                        entityType.entitySet!,
                        keyValue
                    );
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify(response.data, null, 2)
                        }]
                    };
                } catch (error) {
                    this.logger.error(`Error reading entity ${entityType.name}:`, error);
                    return {
                        content: [{
                            type: "text",
                            text: `Error: ${error instanceof Error ? error.message : String(error)}`
                        }],
                        isError: true
                    };
                }
            }
        );
    }

    private registerCreateEntityTool(service: ODataService, entityType: EntityType): void {
        const createSchema: { [key: string]: z.ZodTypeAny } = {};
        const requiredFields: string[] = [];
        entityType.properties.forEach(prop => {
            if (!entityType.keys.includes(prop.name)) {
                createSchema[prop.name] = this.getZodSchemaForODataType(prop.type)
                    .describe(`${prop.name}${prop.maxLength ? ` (max length: ${prop.maxLength})` : ''}`);
                if (!prop.nullable) {
                    requiredFields.push(prop.name);
                }
            }
        });
        const finalSchema: { [key: string]: z.ZodTypeAny } = {};
        Object.entries(createSchema).forEach(([key, schema]) => {
            finalSchema[key] = schema.optional();
        });
        const shortName = this.generateShortToolName('c', service.id, entityType.name);
        this.mcpServer.registerTool(
            shortName,
            {
                title: `Create ${entityType.name} Entity`,
                description: `Create a new ${entityType.name} entity in service '${service.title}' (${service.id}). Required fields: ${requiredFields.join(', ')}. Available properties: ${entityType.properties.filter(p => !entityType.keys.includes(p.name)).map(p => p.name).join(', ')}. Full identifier: create-entity--${service.id}--${entityType.name}`,
                inputSchema: finalSchema
            },
            async (args: Record<string, unknown>) => {
                try {
                    const response = await this.sapClient.createEntity(
                        service.url,
                        entityType.entitySet!,
                        args
                    );
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify(response.data, null, 2)
                        }]
                    };
                } catch (error) {
                    this.logger.error(`Error creating entity ${entityType.name}:`, error);
                    return {
                        content: [{
                            type: "text",
                            text: `Error: ${error instanceof Error ? error.message : String(error)}`
                        }],
                        isError: true
                    };
                }
            }
        );
    }

    private registerUpdateEntityTool(service: ODataService, entityType: EntityType): void {
        const keyProperties = entityType.properties.filter(p => entityType.keys.includes(p.name));
        const updateProperties = entityType.properties.filter(p => !entityType.keys.includes(p.name));
        const updateSchema: { [key: string]: z.ZodTypeAny } = {};
        keyProperties.forEach(prop => {
            updateSchema[prop.name] = this.getZodSchemaForODataType(prop.type).describe(`Key property: ${prop.name}`);
        });
        updateProperties.forEach(prop => {
            updateSchema[prop.name] = this.getZodSchemaForODataType(prop.type)
                .optional()
                .describe(`${prop.name}${prop.maxLength ? ` (max length: ${prop.maxLength})` : ''}`);
        });
        const shortName = this.generateShortToolName('u', service.id, entityType.name);
        this.mcpServer.registerTool(
            shortName,
            {
                title: `Update ${entityType.name} Entity`,
                description: `Update an existing ${entityType.name} entity in service '${service.title}' (${service.id}). Key properties: ${keyProperties.map(p => p.name).join(', ')}. Updatable properties: ${updateProperties.map(p => p.name).join(', ')}. Full identifier: update-entity--${service.id}--${entityType.name}`,
                inputSchema: updateSchema
            },
            async (args: Record<string, unknown>) => {
                const keyValue = this.buildKeyValue(keyProperties, args);
                const updateData = { ...args };
                keyProperties.forEach(prop => delete updateData[prop.name]);
                try {
                    const response = await this.sapClient.updateEntity(
                        service.url,
                        entityType.entitySet!,
                        keyValue,
                        updateData
                    );
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify(response.data, null, 2)
                        }]
                    };
                } catch (error) {
                    this.logger.error(`Error updating entity ${entityType.name}:`, error);
                    return {
                        content: [{
                            type: "text",
                            text: `Error: ${error instanceof Error ? error.message : String(error)}`
                        }],
                        isError: true
                    };
                }
            }
        );
    }

    private registerDeleteEntityTool(service: ODataService, entityType: EntityType): void {
        const keyProperties = entityType.properties.filter(p => entityType.keys.includes(p.name));
        const keySchema: { [key: string]: z.ZodTypeAny } = {};
        keyProperties.forEach(prop => {
            keySchema[prop.name] = this.getZodSchemaForODataType(prop.type).describe(`Key property: ${prop.name}`);
        });
        const shortName = this.generateShortToolName('d', service.id, entityType.name);
        this.mcpServer.registerTool(
            shortName,
            {
                title: `Delete ${entityType.name} Entity`,
                description: `Delete a ${entityType.name} entity from service '${service.title}' (${service.id}). Key properties: ${keyProperties.map(p => p.name).join(', ')}. Full identifier: delete-entity--${service.id}--${entityType.name}`,
                inputSchema: keySchema
            },
            async (args: Record<string, unknown>) => {
                const keyValue = this.buildKeyValue(keyProperties, args);
                try {
                    await this.sapClient.deleteEntity(
                        service.url,
                        entityType.entitySet!,
                        keyValue
                    );
                    return {
                        content: [{
                            type: "text",
                            text: `Successfully deleted ${entityType.name} with key: ${keyValue}`
                        }]
                    };
                } catch (error) {
                    this.logger.error(`Error deleting entity ${entityType.name}:`, error);
                    return {
                        content: [{
                            type: "text",
                            text: `Error: ${error instanceof Error ? error.message : String(error)}`
                        }],
                        isError: true
                    };
                }
            }
        );
    }

    private formatKeyValue(value: unknown, type: string): string {
        switch (type) {
            case 'Edm.Guid':
            case 'Edm.Int16':
            case 'Edm.Int32':
            case 'Edm.Int64':
            case 'Edm.Boolean':
                return String(value);
            case 'Edm.Decimal':
                return `${value}M`;
            case 'Edm.Double':
                return `${value}d`;
            default:
                return `'${value}'`;
        }
    }

    private buildKeyValue(keyProperties: { name: string; type: string }[], args: Record<string, unknown>): string {
        if (keyProperties.length === 1) {
            return this.formatKeyValue(args[keyProperties[0].name], keyProperties[0].type);
        }
        const keyParts = keyProperties.map(prop => `${prop.name}=${this.formatKeyValue(args[prop.name], prop.type)}`);
        return keyParts.join(',');
    }

    private getZodSchemaForODataType(odataType: string): z.ZodTypeAny {
        switch (odataType) {
            case 'Edm.String':
                return z.string();
            case 'Edm.Int32':
            case 'Edm.Int16':
            case 'Edm.Int64':
            case 'Edm.Decimal':
            case 'Edm.Double':
            case 'Edm.Single':
                return z.number();
            case 'Edm.Boolean':
                return z.boolean();
            case 'Edm.DateTime':
            case 'Edm.DateTimeOffset':
            case 'Edm.Date':
            case 'Edm.Time':
                return z.string();
            default:
                return z.string();
        }
    }

    private generateShortToolName(operation: string, serviceId: string, entityName: string): string {
        let candidate = `${operation}-${serviceId}-${entityName}`;
        if(candidate.length <= 64) {
            return candidate;
        }
        const serviceAbbr = this.abbreviateServiceId(serviceId);
        const entityAbbr = this.abbreviateEntityName(entityName);
        candidate = `${operation}-${serviceAbbr}-${entityAbbr}`;
        if (candidate.length > 60) {
            const serviceHash = this.getShortHash(serviceId, 8);
            const entityHash = this.getShortHash(entityName, 8);
            candidate = `${operation}-${serviceHash}-${entityHash}`;
        }
        let finalName = candidate;
        let counter = 1;
        while (this.usedShortNames.has(finalName)) {
            const suffix = `-${counter}`;
            const maxBase = 64 - suffix.length;
            finalName = candidate.substring(0, maxBase) + suffix;
            counter++;
        }
        this.usedShortNames.add(finalName);
        this.toolNameMapping.set(finalName, `${operation}--${serviceId}--${entityName}`);
        return finalName;
    }

    private abbreviateServiceId(serviceId: string): string {
        let abbr = serviceId;
        abbr = abbr.replace(/^(ZBP_|ZC_|ZI_|YBP_|YC_|YI_)/, '');
        abbr = abbr.replace(/(_SRV|_SRV_0001|_CDS|_SERVICE)(_\d+)?$/, '');
        if (abbr.length > 12) {
            const parts = abbr.split('_').filter(p => p.length > 0);
            if (parts.length > 2) {
                abbr = parts[0] + '_' + parts[parts.length - 1];
            }
            if (abbr.length > 12) {
                abbr = abbr.substring(0, 12);
            }
        }
        return abbr;
    }

    private abbreviateEntityName(entityName: string): string {
        let abbr = entityName;
        if (/^[A-Z][a-z]/.test(abbr)) {
            const capitals = abbr.match(/[A-Z]/g);
            if (capitals && capitals.length > 1) {
                abbr = capitals.join('');
            }
        }
        if (abbr.length > 12) {
            abbr = abbr.substring(0, 12);
        }
        return abbr;
    }

    private getShortHash(input: string, length: number = 8): string {
        return createHash('sha256').update(input).digest('hex').substring(0, length);
    }

    /**
     * Clean query options by removing null and undefined values
     * @param args Raw arguments from MCP tool call
     * @returns Clean query options object
     */
    static buildQueryOptions(args: Record<string, unknown>): Record<string, string | number> {
        const queryOptions: Record<string, string | number> = {};
        if (args.filter !== null && args.filter !== undefined && args.filter !== '') {
            queryOptions.$filter = args.filter as string;
        }
        if (args.select !== null && args.select !== undefined && args.select !== '') {
            queryOptions.$select = args.select as string;
        }
        if (args.expand !== null && args.expand !== undefined && args.expand !== '') {
            queryOptions.$expand = args.expand as string;
        }
        if (args.orderby !== null && args.orderby !== undefined && args.orderby !== '') {
            queryOptions.$orderby = args.orderby as string;
        }
        if (args.top !== null && args.top !== undefined && typeof args.top === 'number' && args.top > 0) {
            queryOptions.$top = args.top;
        }
        if (args.skip !== null && args.skip !== undefined && typeof args.skip === 'number' && args.skip >= 0) {
            queryOptions.$skip = args.skip;
        }
        return queryOptions;
    }
}
