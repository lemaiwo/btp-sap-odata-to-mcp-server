import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SAPClient } from "../services/sap-client.js";
import { Logger } from "../utils/logger.js";
import { ODataService, EntityType } from "../types/sap-types.js";
import { z } from "zod";

/**
 * Hierarchical Tool Registry - Solves the "tool explosion" problem
 *
 * Instead of registering hundreds of CRUD tools upfront (5 ops × 40+ entities × services),
 * this registry uses an intelligent discovery approach with just 2 smart tools:
 * 1. discover-sap-data - Universal intelligent search across services, entities, and properties
 *                        with context-aware detail levels (summary for search, full for direct access)
 * 2. execute-sap-operation - Perform CRUD operations on any entity
 *
 * This reduces AI assistant context from 200+ tools to just 2, solving token overflow
 * and dramatically improving tool selection for AI assistants like Claude and Microsoft Copilot.
 */
export class HierarchicalSAPToolRegistry {
    private serviceCategories = new Map<string, string[]>();
    private userToken?: string;

    constructor(
        private mcpServer: McpServer,
        private sapClient: SAPClient,
        private logger: Logger,
        private discoveredServices: ODataService[]
    ) {
        this.categorizeServices();
    }

    /**
     * Set the user's JWT token for authenticated operations
     */
    setUserToken(token?: string) {
        this.userToken = token;
        this.sapClient.setUserToken(token);
        this.logger.debug(`User token ${token ? 'set' : 'cleared'} for tool registry`);
    }

    /**
     * Register the 2 intelligent discovery tools instead of 200+ individual CRUD tools
     */
    public async registerDiscoveryTools(): Promise<void> {
        this.logger.info(`🔧 Registering intelligent discovery tools for ${this.discoveredServices.length} services`);

        // Tool 1: Intelligent universal discovery - Returns mapping table for easy LLM consumption
        this.mcpServer.registerTool(
            "discover-sap-data",
            {
                title: "Discover SAP Data",
                description: "[SINGLE-USE DISCOVERY TOOL] Call this tool ONCE and you will receive EVERYTHING you need as a MAPPING TABLE. Returns a flat table with columns: Service ID, Service Name, Entity Name, Property Name, Property Type, Is Key, Capabilities. This table format is optimized for LLM consumption - easy to scan and find the right API. WARNING: NEVER call this tool multiple times with different queries - the first call gives you full information. After receiving the mapping table, proceed IMMEDIATELY to execute-sap-operation. DO NOT try variations like searching for service IDs, entity names, or refined queries - you already have complete data. Discovery uses technical user (no auth needed), but execute operations require user authentication.",
                inputSchema: {
                    query: z.string().optional().describe("Search term to find services, entities, or properties. Searches across service names, entity names, and property names. Examples: 'customer', 'email', 'sales order'. If omitted, returns ALL available services and entities. Returns a MAPPING TABLE with ALL entities and properties in ONE call - you will have EVERYTHING you need after this single call."),
                    category: z.string().optional().describe("Service category filter. Valid values: business-partner, sales, finance, procurement, hr, logistics, all. Default: all. Narrows search results to specific business area. If no results found with specified category, automatically retries with 'all' categories in the same request."),
                    limit: z.number().min(1).max(20).optional().describe("Maximum number of services/entities to return. Default: 10. Use this to control result set size. Note: This limits the number of matched services/entities, but each entity will include ALL its properties in the mapping table.")
                }
            },
            async (args: Record<string, unknown>) => {
                return this.discoverDataUnified(args);
            }
        );

        // Tool 2: Execute operations on entities
        this.mcpServer.registerTool(
            "execute-sap-operation",
            {
                title: "Execute SAP Operation",
                description: "AUTHENTICATION REQUIRED: Perform CRUD operations on SAP entities using authenticated user context. This tool requires valid JWT token for authorization and audit trail. Use discover-sap-data first to find and understand available services and entities. Operations execute under user's SAP identity.",
                inputSchema: {
                    serviceId: z.string().describe("The SAP service ID from discover-sap-data. IMPORTANT: Use the 'id' field from the search results, NOT the 'title' field."),
                    entityName: z.string().describe("The entity name from discover-sap-data. IMPORTANT: Use the 'name' field from the results, NOT the 'entitySet' field."),
                    operation: z.string().describe("The operation to perform. Valid values: read, read-single, create, update, delete"),
                    parameters: z.record(z.any()).optional().describe("Operation parameters such as keys, filters, and data. For read-single/update/delete operations, include the entity key properties. For create/update operations, include the entity data fields."),
                    filterString: z.string().optional().describe("OData $filter query option value. Use OData filter syntax without the '$filter=' prefix. Examples: \"Status eq 'Active'\", \"Amount gt 1000\", \"Name eq 'John' and Status eq 'Active'\". Common operators: eq (equals), ne (not equals), gt (greater than), lt (less than), ge (greater/equal), le (less/equal), and, or, not."),
                    selectString: z.string().optional().describe("OData $select query option value. Comma-separated list of property names to include in the response, without the '$select=' prefix. Example: \"Name,Status,CreatedDate\" or \"CustomerID,CustomerName\"."),
                    expandString: z.string().optional().describe("OData $expand query option value. Comma-separated list of navigation properties to expand, without the '$expand=' prefix. Example: \"Customer,Items\" or \"OrderDetails\"."),
                    orderbyString: z.string().optional().describe("OData $orderby query option value. Specify property name and direction (asc/desc), without the '$orderby=' prefix. Examples: \"Name desc\", \"CreatedDate asc\", \"Amount desc, Name asc\"."),
                    topNumber: z.number().optional().describe("OData $top query option value. Number of records to return (limit/page size). This will be converted to the $top parameter. Example: 10 returns top 10 records."),
                    skipNumber: z.number().optional().describe("OData $skip query option value. Number of records to skip (offset for pagination). This will be converted to the $skip parameter. Example: 20 skips first 20 records."),
                    useUserToken: z.boolean().optional().describe("Use the authenticated user's token for this operation. Default: true for data operations")
                }
            },
            async (args: Record<string, unknown>) => {
                return this.executeEntityOperation(args);
            }
        );

        this.logger.info("✅ Registered 2 intelligent discovery tools successfully");
    }

    /**
     * Categorize services for better discovery using intelligent pattern matching
     */
    private categorizeServices(): void {
        for (const service of this.discoveredServices) {
            const categories: string[] = [];
            const id = service.id.toLowerCase();
            const title = service.title.toLowerCase();
            const desc = service.description.toLowerCase();

            // Business Partner related
            if (id.includes('business_partner') || id.includes('bp_') || id.includes('customer') || id.includes('supplier') ||
                title.includes('business partner') || title.includes('customer') || title.includes('supplier')) {
                categories.push('business-partner');
            }

            // Sales related
            if (id.includes('sales') || id.includes('order') || id.includes('quotation') || id.includes('opportunity') ||
                title.includes('sales') || title.includes('order') || desc.includes('sales')) {
                categories.push('sales');
            }

            // Finance related
            if (id.includes('finance') || id.includes('accounting') || id.includes('payment') || id.includes('invoice') ||
                id.includes('gl_') || id.includes('ar_') || id.includes('ap_') || title.includes('finance') ||
                title.includes('accounting') || title.includes('payment')) {
                categories.push('finance');
            }

            // Procurement related
            if (id.includes('purchase') || id.includes('procurement') || id.includes('vendor') || id.includes('po_') ||
                title.includes('procurement') || title.includes('purchase') || title.includes('vendor')) {
                categories.push('procurement');
            }

            // HR related
            if (id.includes('employee') || id.includes('hr_') || id.includes('personnel') || id.includes('payroll') ||
                title.includes('employee') || title.includes('human') || title.includes('personnel')) {
                categories.push('hr');
            }

            // Logistics related
            if (id.includes('logistics') || id.includes('warehouse') || id.includes('inventory') || id.includes('material') ||
                id.includes('wm_') || id.includes('mm_') || title.includes('logistics') || title.includes('material')) {
                categories.push('logistics');
            }

            // Default category if none matched
            if (categories.length === 0) {
                categories.push('all');
            }

            this.serviceCategories.set(service.id, categories);
        }

        this.logger.debug(`Categorized ${this.discoveredServices.length} services into categories`);
    }

    /**
     * Intelligent unified discovery method - SIMPLIFIED to query-only interface
     * Always returns full schemas for maximum efficiency (avoids follow-up requests)
     *
     * Behavior:
     * - If query provided: Search with that term
     * - If no query and no category: Return ALL services and entities
     * - If category provided: Filter by that category
     * - Returns COMPLETE entity information in ONE call
     * - No need for follow-up calls with serviceId/entityName
     */
    private async discoverDataUnified(args: Record<string, unknown>) {
        // Always use search method - it handles empty queries and returns everything
        return this.searchServicesAndEntities(args);
    }

    /**
     * Helper method to check if text matches query (supports multi-word queries)
     * Returns true if:
     * - Single word: text contains the word
     * - Multiple words separated: text contains ALL words
     */
    private matchesQuery(text: string, query: string, searchMode: 'combined' | 'separated'): boolean {
        if (!query) return false;

        const textLower = text.toLowerCase();

        if (searchMode === 'combined') {
            // Try as combined query (e.g., "userparameters")
            return textLower.includes(query);
        } else {
            // Try as separated words (e.g., "user" AND "parameters")
            const words = query.split(/\s+/).filter(w => w.length > 0);
            if (words.length === 0) return false;
            if (words.length === 1) return textLower.includes(words[0]);

            // All words must be present
            return words.every(word => textLower.includes(word));
        }
    }

    /**
     * Helper method to perform search across services and entities for a given category
     * Extracts common search logic to avoid duplication in fallback scenario
     * Supports multi-word queries with intelligent matching
     */
    private performCategorySearch(query: string, category: string, searchMode: 'combined' | 'separated' = 'combined'): any[] {
        const matches: any[] = [];

        // Search across all services
        for (const service of this.discoveredServices) {
            // Filter by category first
            if (category !== "all") {
                const serviceCategories = this.serviceCategories.get(service.id) || [];
                if (!serviceCategories.includes(category)) {
                    continue;
                }
            }

            const serviceIdLower = service.id.toLowerCase();
            const serviceTitleLower = service.title.toLowerCase();
            const serviceDescLower = service.description.toLowerCase();

            // Service-level match with multi-word support
            let serviceScore = 0;
            if (query) {
                if (this.matchesQuery(serviceIdLower, query, searchMode)) serviceScore = 0.9;
                else if (this.matchesQuery(serviceTitleLower, query, searchMode)) serviceScore = 0.85;
                else if (this.matchesQuery(serviceDescLower, query, searchMode)) serviceScore = 0.7;
            }

            if (serviceScore > 0 || !query) {
                // Always include full entity schemas even for service-level matches
                const entities = service.metadata?.entityTypes?.map(entity => ({
                    name: entity.name,
                    entitySet: entity.entitySet,
                    keyProperties: entity.keys,
                    propertyCount: entity.properties.length,
                    capabilities: {
                        readable: true,
                        creatable: entity.creatable,
                        updatable: entity.updatable,
                        deletable: entity.deletable
                    },
                    properties: entity.properties.map(prop => ({
                        name: prop.name,
                        type: prop.type,
                        nullable: prop.nullable,
                        maxLength: prop.maxLength,
                        isKey: entity.keys.includes(prop.name)
                    }))
                })) || [];

                matches.push({
                    type: "service",
                    score: serviceScore || 0.5,
                    service: {
                        id: service.id,
                        title: service.title,
                        description: service.description,
                        entityCount: service.metadata?.entityTypes?.length || 0,
                        categories: this.serviceCategories.get(service.id) || []
                    },
                    // Include all entities with full schemas
                    entities: entities,
                    matchReason: serviceScore > 0 ? `Service matches '${query}'` : `Service in category '${category}'`
                });
            }

            // Entity-level matches within this service
            if (service.metadata?.entityTypes && query) {
                for (const entity of service.metadata.entityTypes) {
                    const entityNameLower = entity.name.toLowerCase();
                    let entityScore = 0;

                    // Match entity name with multi-word support
                    if (this.matchesQuery(entityNameLower, query, searchMode)) {
                        entityScore = 0.95;
                    }

                    // Match property names with multi-word support
                    let matchedProperties: string[] = [];
                    for (const prop of entity.properties) {
                        if (this.matchesQuery(prop.name.toLowerCase(), query, searchMode)) {
                            matchedProperties.push(prop.name);
                            if (entityScore === 0) entityScore = 0.75;
                        }
                    }

                    if (entityScore > 0) {
                        const match: any = {
                            type: entityScore >= 0.9 ? "entity" : "property",
                            score: entityScore,
                            service: {
                                id: service.id,
                                title: service.title
                            },
                            entity: {
                                name: entity.name,
                                entitySet: entity.entitySet,
                                keyProperties: entity.keys,
                                propertyCount: entity.properties.length,
                                capabilities: {
                                    readable: true,
                                    creatable: entity.creatable,
                                    updatable: entity.updatable,
                                    deletable: entity.deletable
                                },
                                // Always include full schema for maximum efficiency
                                properties: entity.properties.map(prop => ({
                                    name: prop.name,
                                    type: prop.type,
                                    nullable: prop.nullable,
                                    maxLength: prop.maxLength,
                                    isKey: entity.keys.includes(prop.name)
                                }))
                            },
                            matchReason: entityScore >= 0.9
                                ? `Entity '${entity.name}' matches '${query}'`
                                : `Properties [${matchedProperties.join(', ')}] match '${query}'`
                        };

                        matches.push(match);
                    }
                }
            }
        }

        return matches;
    }

    /**
     * Intelligent search across services, entities, and properties
     * Returns a flat mapping table for easy LLM consumption
     * Multi-word query support with intelligent 3-level fallback:
     * 1. Try combined words with requested category
     * 2. If no results: try separated words with requested category
     * 3. If still no results with specific category: try with 'all' categories
     * 4. If still no results: try separated words with 'all' categories
     */
    private async searchServicesAndEntities(args: Record<string, unknown>) {
        try {
            const query = (args.query as string)?.toLowerCase() || "";
            const requestedCategory = (args.category as string)?.toLowerCase() || "all";
            const limit = (args.limit as number) || 10;

            // Validate category
            const validCategories = ["business-partner", "sales", "finance", "procurement", "hr", "logistics", "all"];
            let category = validCategories.includes(requestedCategory) ? requestedCategory : "all";

            let matches: any[] = [];
            let searchMode: 'combined' | 'separated' = 'combined';
            let usedCategoryFallback = false;
            let usedSeparatedWords = false;
            let returnedAllServices = false;

            // Level 1: Try combined words with requested category
            matches = this.performCategorySearch(query, category, 'combined');

            // Level 2: If no results and multi-word query, try separated words with same category
            if (matches.length === 0 && query && query.includes(' ')) {
                this.logger.debug(`No results with combined query, trying separated words in category '${category}'`);
                searchMode = 'separated';
                usedSeparatedWords = true;
                matches = this.performCategorySearch(query, category, 'separated');
            }

            // Level 3: If still no results with specific category, try with 'all'
            if (matches.length === 0 && category !== "all" && query) {
                this.logger.debug(`No results in category '${category}', retrying with 'all' categories`);
                category = "all";
                usedCategoryFallback = true;

                // Try combined first
                matches = this.performCategorySearch(query, category, 'combined');
                searchMode = 'combined';
                usedSeparatedWords = false;

                // Level 4: If still no results and multi-word, try separated with 'all'
                if (matches.length === 0 && query.includes(' ')) {
                    this.logger.debug(`No results with combined query in 'all', trying separated words`);
                    searchMode = 'separated';
                    usedSeparatedWords = true;
                    matches = this.performCategorySearch(query, category, 'separated');
                }
            }

            // Level 5: If still no results after all attempts, return ALL services with full schemas
            if (matches.length === 0 && query) {
                this.logger.debug(`No results found for query '${query}', returning all available services with full schemas`);
                // Return all services with complete entity schemas
                matches = this.performCategorySearch("", category, 'combined');
                returnedAllServices = true;
                usedCategoryFallback = true;
            }

            // Sort by relevance score
            matches.sort((a, b) => b.score - a.score);

            // Apply limit to matches before converting to mapping table
            const totalFound = matches.length;
            const limitedMatches = matches.slice(0, limit);

            // Convert matches to flat mapping table
            const mappingTable = this.convertToMappingTable(limitedMatches);

            const result = {
                query: query || "all",
                requestedCategory: requestedCategory,
                actualCategory: category,
                searchMode: searchMode,
                usedCategoryFallback: usedCategoryFallback,
                usedSeparatedWords: usedSeparatedWords,
                returnedAllServices: returnedAllServices,
                totalFound: totalFound,
                totalProperties: mappingTable.length,
                showing: limitedMatches.length,
                mappingTable: mappingTable
            };

            // Build response with GUIDANCE FIRST, then data
            let responseText = "";

            if (mappingTable.length > 0) {
                responseText += `*** DISCOVERY COMPLETE - YOU HAVE EVERYTHING YOU NEED! ***\n\n`;
                responseText += `[COMPLETE] This response contains a MAPPING TABLE with service IDs, entity names, and properties\n`;
                responseText += `[STOP] NO additional discovery needed - Do NOT call discover-sap-data again\n`;
                responseText += `[NEXT] Use execute-sap-operation immediately with the data below\n\n`;
                if (returnedAllServices) {
                    responseText += `NOTICE: No matches found for "${query}", so returning ALL available services\n\n`;
                }
                responseText += `SUMMARY: Found ${totalFound} matching services/entities`;
                if (query && !returnedAllServices) responseText += ` for "${query}"`;
                if (requestedCategory !== "all") responseText += ` in category "${requestedCategory}"`;
                if (usedCategoryFallback && !returnedAllServices) responseText += ` (searched all categories)`;
                if (usedSeparatedWords) responseText += ` (matched separated words)`;
                responseText += `, showing ${limitedMatches.length} with ${mappingTable.length} total properties\n\n`;

                // Show example of how to use the first result
                const firstRow = mappingTable[0];
                responseText += `EXECUTE WITH THESE VALUES:\n`;
                responseText += `  serviceId: "${firstRow.serviceId}"\n`;
                responseText += `  entityName: "${firstRow.entityName}"\n`;
                responseText += `  operation: read | read-single | create | update | delete\n`;
                responseText += `  Available operations: ${firstRow.capabilities}\n\n`;

                responseText += `================================================\n`;
                responseText += `MAPPING TABLE (scan this to find the right API):\n`;
                responseText += `================================================\n\n`;
                responseText += this.formatMappingTableAsText(mappingTable);
                responseText += `\n\n`;
                responseText += `== HOW TO USE THIS TABLE ==\n`;
                responseText += `1. Find the entity you need by scanning the "Entity Name" column\n`;
                responseText += `2. Check the properties available in that entity\n`;
                responseText += `3. Note the "Service ID" for that row\n`;
                responseText += `4. Use execute-sap-operation with:\n`;
                responseText += `   - serviceId: from "Service ID" column\n`;
                responseText += `   - entityName: from "Entity Name" column\n`;
                responseText += `   - operation: check "Capabilities" to see what's allowed\n`;
                responseText += `   - parameters: use property names from "Property Name" column\n\n`;
                responseText += `== FULL JSON DATA ==\n`;
                responseText += JSON.stringify(result, null, 2);
            } else {
                responseText += `No matches found`;
                if (query) responseText += ` for "${query}"`;
                if (requestedCategory !== "all") responseText += ` in category "${requestedCategory}"`;
                responseText += `\n\n== SUGGESTION ==`;
                responseText += `\nTry different search terms or categories: business-partner, sales, finance, procurement, hr, logistics, all`;
            }

            return {
                content: [{
                    type: "text" as const,
                    text: responseText
                }]
            };

        } catch (error) {
            this.logger.error('Error searching services and entities:', error);
            return {
                content: [{
                    type: "text" as const,
                    text: `Error searching: ${error instanceof Error ? error.message : String(error)}`
                }],
                isError: true
            };
        }
    }

    /**
     * Convert matches to a flat mapping table
     * Each row represents one property in an entity
     */
    private convertToMappingTable(matches: any[]): any[] {
        const mappingTable: any[] = [];

        for (const match of matches) {
            // Handle service-level matches (includes entities)
            if (match.type === 'service' && match.entities) {
                for (const entity of match.entities) {
                    const capabilities = `R:${entity.capabilities.readable ? 'Y' : 'N'} C:${entity.capabilities.creatable ? 'Y' : 'N'} U:${entity.capabilities.updatable ? 'Y' : 'N'} D:${entity.capabilities.deletable ? 'Y' : 'N'}`;

                    for (const prop of entity.properties) {
                        mappingTable.push({
                            serviceId: match.service.id,
                            serviceName: match.service.title,
                            entityName: entity.name,
                            entitySet: entity.entitySet,
                            propertyName: prop.name,
                            propertyType: prop.type,
                            isKey: prop.isKey,
                            nullable: prop.nullable,
                            maxLength: prop.maxLength || 'N/A',
                            capabilities: capabilities
                        });
                    }
                }
            }
            // Handle entity-level matches
            else if ((match.type === 'entity' || match.type === 'property') && match.entity) {
                const entity = match.entity;
                const capabilities = `R:${entity.capabilities.readable ? 'Y' : 'N'} C:${entity.capabilities.creatable ? 'Y' : 'N'} U:${entity.capabilities.updatable ? 'Y' : 'N'} D:${entity.capabilities.deletable ? 'Y' : 'N'}`;

                for (const prop of entity.properties) {
                    mappingTable.push({
                        serviceId: match.service.id,
                        serviceName: match.service.title,
                        entityName: entity.name,
                        entitySet: entity.entitySet,
                        propertyName: prop.name,
                        propertyType: prop.type,
                        isKey: prop.isKey,
                        nullable: prop.nullable,
                        maxLength: prop.maxLength || 'N/A',
                        capabilities: capabilities
                    });
                }
            }
        }

        return mappingTable;
    }

    /**
     * Format mapping table as readable text table
     */
    private formatMappingTableAsText(mappingTable: any[]): string {
        if (mappingTable.length === 0) return "No data";

        let output = "";

        // Group by service and entity for better readability
        const grouped = new Map<string, Map<string, any[]>>();

        for (const row of mappingTable) {
            const serviceKey = `${row.serviceId} (${row.serviceName})`;
            if (!grouped.has(serviceKey)) {
                grouped.set(serviceKey, new Map());
            }

            const serviceGroup = grouped.get(serviceKey)!;
            if (!serviceGroup.has(row.entityName)) {
                serviceGroup.set(row.entityName, []);
            }

            serviceGroup.get(row.entityName)!.push(row);
        }

        // Format output
        for (const [serviceKey, entities] of grouped) {
            output += `SERVICE: ${serviceKey}\n`;
            output += `${'='.repeat(80)}\n\n`;

            for (const [entityName, properties] of entities) {
                const firstProp = properties[0];
                output += `  ENTITY: ${entityName}\n`;
                output += `  Entity Set: ${firstProp.entitySet}\n`;
                output += `  Capabilities: ${firstProp.capabilities}\n`;
                output += `  Properties:\n`;
                output += `  ${'─'.repeat(76)}\n`;
                output += `  ${'Property Name'.padEnd(30)} ${'Type'.padEnd(20)} ${'Key'.padEnd(5)} ${'Nullable'.padEnd(10)} ${'MaxLen'}\n`;
                output += `  ${'─'.repeat(76)}\n`;

                for (const prop of properties) {
                    output += `  ${prop.propertyName.padEnd(30)} ${prop.propertyType.padEnd(20)} ${(prop.isKey ? 'YES' : 'NO').padEnd(5)} ${(prop.nullable ? 'YES' : 'NO').padEnd(10)} ${prop.maxLength}\n`;
                }

                output += `\n`;
            }

            output += `\n`;
        }

        return output;
    }

    /**
     * Legacy search services method (kept for backward compatibility)
     */
    private async searchServices(args: Record<string, unknown>) {
        try {
            const query = (args.query as string)?.toLowerCase() || "";
            let category = (args.category as string)?.toLowerCase() || "all";
            const limit = (args.limit as number) || 10;

            // Validate category for better Copilot compatibility
            const validCategories = ["business-partner", "sales", "finance", "procurement", "hr", "logistics", "all"];
            if (!validCategories.includes(category)) {
                category = "all"; // Default to 'all' if invalid category provided
            }

            let filteredServices = this.discoveredServices;

            // Filter by category first
            if (category && category !== "all") {
                filteredServices = filteredServices.filter(service =>
                    this.serviceCategories.get(service.id)?.includes(category)
                );
            }

            // Filter by search query
            if (query) {
                filteredServices = filteredServices.filter(service =>
                    service.id.toLowerCase().includes(query) ||
                    service.title.toLowerCase().includes(query) ||
                    service.description.toLowerCase().includes(query)
                );
            }

            // Apply limit
            const totalFound = filteredServices.length;
            filteredServices = filteredServices.slice(0, limit);

            const result = {
                query: query || "all",
                category: category,
                totalFound: totalFound,
                showing: filteredServices.length,
                services: filteredServices.map(service => ({
                    id: service.id,
                    title: service.title,
                    description: service.description,
                    entityCount: service.metadata?.entityTypes?.length || 0,
                    categories: this.serviceCategories.get(service.id) || [],
                    version: service.version,
                    odataVersion: service.odataVersion
                }))
            };

            let responseText = `Found ${totalFound} SAP services`;
            if (query) responseText += ` matching "${query}"`;
            if (category !== "all") responseText += ` in category "${category}"`;
            responseText += `:\n\n${JSON.stringify(result, null, 2)}`;

            if (result.services.length > 0) {
                responseText += `\n\n== NEXT STEPS ==`;
                responseText += `\n1. Call 'discover-sap-data' with serviceId parameter to see entities within a service`;
                responseText += `\n2. Set serviceId to the 'id' field from the results above`;
                responseText += `\n3. IMPORTANT: Use the 'id' field as serviceId, NOT the 'title' field`;
            } else {
                responseText += `\n\n== SUGGESTION ==`;
                responseText += `\nTry different search terms or categories: business-partner, sales, finance, procurement, hr, logistics, all`;
            }

            return {
                content: [{
                    type: "text" as const,
                    text: responseText
                }]
            };

        } catch (error) {
            this.logger.error('Error searching services:', error);
            return {
                content: [{
                    type: "text" as const,
                    text: `Error searching services: ${error instanceof Error ? error.message : String(error)}`
                }],
                isError: true
            };
        }
    }

    /**
     * Discover entities within a service with full schemas
     * Always returns complete property details for maximum efficiency
     *
     * NOTE: This method is kept for potential future use but is NOT exposed via the tool interface.
     * The query-based search already returns full schemas, making this redundant.
     */
    private async discoverServiceEntities(args: Record<string, unknown>) {
        try {
            const serviceId = args.serviceId as string;

            const service = this.discoveredServices.find(s => s.id === serviceId);
            if (!service) {
                // Check if user provided a title instead of an id
                const serviceByTitle = this.discoveredServices.find(s => s.title.toLowerCase() === serviceId.toLowerCase());
                let errorMessage = `ERROR: Service not found: ${serviceId}\n\n`;

                if (serviceByTitle) {
                    errorMessage += `WARNING: It looks like you used the 'title' field instead of the 'id' field!\n`;
                    errorMessage += `CORRECTION: Use this serviceId instead: ${serviceByTitle.id}\n\n`;
                    errorMessage += `Remember: Always use the 'id' field from discover-sap-data results, NOT the 'title' field.`;
                } else {
                    errorMessage += `SUGGESTION: Use 'discover-sap-data' to find available services.\n`;
                    errorMessage += `REMINDER: Make sure you're using the 'id' field from search results, NOT the 'title' field.`;
                }

                return {
                    content: [{
                        type: "text" as const,
                        text: errorMessage
                    }],
                    isError: true
                };
            }

            if (!service.metadata?.entityTypes) {
                return {
                    content: [{
                        type: "text" as const,
                        text: `WARNING: No entities found for service: ${serviceId}. The service metadata may not have loaded properly.`
                    }]
                };
            }

            // Always include full schemas for maximum efficiency
            const entities = service.metadata.entityTypes.map(entity => ({
                name: entity.name,
                entitySet: entity.entitySet,
                keyProperties: entity.keys,
                propertyCount: entity.properties.length,
                capabilities: {
                    readable: true, // Always true for OData
                    creatable: entity.creatable,
                    updatable: entity.updatable,
                    deletable: entity.deletable
                },
                // Include full property schemas
                properties: entity.properties.map(prop => ({
                    name: prop.name,
                    type: prop.type,
                    nullable: prop.nullable,
                    maxLength: prop.maxLength,
                    isKey: entity.keys.includes(prop.name)
                }))
            }));

            const serviceInfo = {
                service: {
                    id: serviceId,
                    title: service.title,
                    description: service.description,
                    categories: this.serviceCategories.get(service.id) || [],
                    odataVersion: service.odataVersion
                },
                detailLevel: "full",
                entities: entities
            };

            let responseText = `Service: ${service.title} (${serviceId})\n`;
            responseText += `Found ${entities.length} entities with full schemas\n\n`;
            responseText += JSON.stringify(serviceInfo, null, 2);
            responseText += `\n\n== READY TO EXECUTE ==\n`;
            responseText += `✓ COMPLETE SCHEMAS INCLUDED - All ${entities.length} entity schemas with properties, types, keys, and capabilities are already in the results above\n`;
            responseText += `✓ NO ADDITIONAL DISCOVERY NEEDED - Do NOT call discover-sap-data again\n`;
            responseText += `✓ EXECUTE IMMEDIATELY - Use execute-sap-operation now with:\n`;
            responseText += `  - serviceId: "${serviceId}"\n`;
            responseText += `  - entityName: Use the 'name' field from entity above (NOT 'entitySet')\n`;
            responseText += `  - operation: read, read-single, create, update, or delete\n`;
            responseText += `  - parameters: Use the property names shown in the schemas above`;

            return {
                content: [{
                    type: "text" as const,
                    text: responseText
                }]
            };

        } catch (error) {
            this.logger.error('Error discovering service entities:', error);
            return {
                content: [{
                    type: "text" as const,
                    text: `ERROR: Failed to discover entities: ${error instanceof Error ? error.message : String(error)}`
                }],
                isError: true
            };
        }
    }

    /**
     * Get detailed entity schema information
     *
     * NOTE: This method is kept for potential future use but is NOT exposed via the tool interface.
     * The query-based search already returns full schemas, making this redundant.
     */
    private async getEntitySchema(args: Record<string, unknown>) {
        try {
            const serviceId = args.serviceId as string;
            const entityName = args.entityName as string;

            const service = this.discoveredServices.find(s => s.id === serviceId);
            if (!service) {
                // Check if user provided a title instead of an id
                const serviceByTitle = this.discoveredServices.find(s => s.title.toLowerCase() === serviceId.toLowerCase());
                let errorMessage = `ERROR: Service not found: ${serviceId}\n\n`;

                if (serviceByTitle) {
                    errorMessage += `WARNING: It looks like you used the 'title' field instead of the 'id' field!\n`;
                    errorMessage += `CORRECTION: Use this serviceId instead: ${serviceByTitle.id}\n\n`;
                    errorMessage += `Remember: Always use the 'id' field from discover-sap-data results, NOT the 'title' field.`;
                } else {
                    errorMessage += `SUGGESTION: Use 'discover-sap-data' to find available services.\n`;
                    errorMessage += `REMINDER: Make sure you're using the 'id' field from search results, NOT the 'title' field.`;
                }
                
                return {
                    content: [{
                        type: "text" as const,
                        text: errorMessage
                    }],
                    isError: true
                };
            }

            const entityType = service.metadata?.entityTypes?.find(e => e.name === entityName);
            if (!entityType) {
                const availableEntities = service.metadata?.entityTypes?.map(e => e.name).join(', ') || 'none';
                return {
                    content: [{
                        type: "text" as const,
                        text: `ERROR: Entity '${entityName}' not found in service '${serviceId}'\n\nAvailable entities: ${availableEntities}`
                    }],
                    isError: true
                };
            }

            const schema = {
                entity: {
                    name: entityType.name,
                    entitySet: entityType.entitySet,
                    namespace: entityType.namespace
                },
                capabilities: {
                    readable: true,
                    creatable: entityType.creatable,
                    updatable: entityType.updatable,
                    deletable: entityType.deletable
                },
                keyProperties: entityType.keys,
                properties: entityType.properties.map(prop => ({
                    name: prop.name,
                    type: prop.type,
                    nullable: prop.nullable,
                    maxLength: prop.maxLength,
                    isKey: entityType.keys.includes(prop.name)
                }))
            };

            let responseText = `Schema for ${entityName} in ${service.title}:\n\n`;
            responseText += JSON.stringify(schema, null, 2);
            responseText += `\n\n== READY TO EXECUTE ==`;
            responseText += `\n✓ COMPLETE SCHEMA INCLUDED - All properties, types, keys, and capabilities are already in the results above`;
            responseText += `\n✓ NO ADDITIONAL DISCOVERY NEEDED - Do NOT call discover-sap-data again`;
            responseText += `\n✓ EXECUTE IMMEDIATELY - Use execute-sap-operation now with:`;
            responseText += `\n  - serviceId: "${serviceId}"`;
            responseText += `\n  - entityName: "${entityName}"`;
            responseText += `\n  - operation: read, read-single, create, update, or delete`;
            responseText += `\n  - parameters: For operations, use keyProperties: [${entityType.keys.join(', ')}]`;
            responseText += `\n  - Check capabilities above: creatable=${entityType.creatable}, updatable=${entityType.updatable}, deletable=${entityType.deletable}`;

            return {
                content: [{
                    type: "text" as const,
                    text: responseText
                }]
            };

        } catch (error) {
            this.logger.error('Error getting entity schema:', error);
            return {
                content: [{
                    type: "text" as const,
                    text: `ERROR: Failed to get schema: ${error instanceof Error ? error.message : String(error)}`
                }],
                isError: true
            };
        }
    }

    /**
     * Execute CRUD operations on entities with comprehensive error handling
     */
    private async executeEntityOperation(args: Record<string, unknown>) {
        try {
            const serviceId = args.serviceId as string;
            const entityName = args.entityName as string;
            let operation = (args.operation as string)?.toLowerCase();
            const parameters = args.parameters as Record<string, unknown> || {};

            // Validate operation for better Copilot compatibility
            const validOperations = ["read", "read-single", "create", "update", "delete"];
            if (!validOperations.includes(operation)) {
                throw new Error(`Invalid operation: ${operation}. Valid operations are: ${validOperations.join(', ')}`);
            }

            // Build queryOptions from flattened parameters for better Copilot compatibility
            const queryOptions: Record<string, unknown> = {};
            if (args.filterString) queryOptions.$filter = args.filterString;
            if (args.selectString) queryOptions.$select = args.selectString;
            if (args.expandString) queryOptions.$expand = args.expandString;
            if (args.orderbyString) queryOptions.$orderby = args.orderbyString;
            if (args.topNumber) queryOptions.$top = args.topNumber;
            if (args.skipNumber) queryOptions.$skip = args.skipNumber;

            // Also support legacy queryOptions object for backward compatibility
            if (args.queryOptions && typeof args.queryOptions === 'object') {
                Object.assign(queryOptions, args.queryOptions);
            }

            const useUserToken = args.useUserToken !== false; // Default to true

            // Validate service
            const service = this.discoveredServices.find(s => s.id === serviceId);
            if (!service) {
                // Check if user provided a title instead of an id
                const serviceByTitle = this.discoveredServices.find(s => s.title.toLowerCase() === serviceId.toLowerCase());
                let errorMessage = `ERROR: Service not found: ${serviceId}\n\n`;

                if (serviceByTitle) {
                    errorMessage += `WARNING: It looks like you used the 'title' field instead of the 'id' field!\n`;
                    errorMessage += `CORRECTION: Use this serviceId instead: ${serviceByTitle.id}\n\n`;
                    errorMessage += `Remember: Always use the 'id' field from discover-sap-data results, NOT the 'title' field.`;
                } else {
                    errorMessage += `SUGGESTION: Use 'discover-sap-data' to find available services.\n`;
                    errorMessage += `REMINDER: Make sure you're using the 'id' field from search results, NOT the 'title' field.`;
                }
                
                return {
                    content: [{
                        type: "text" as const,
                        text: errorMessage
                    }],
                    isError: true
                };
            }

            // Validate entity
            const entityType = service.metadata?.entityTypes?.find(e => e.name === entityName);
            if (!entityType) {
                return {
                    content: [{
                        type: "text" as const,
                        text: `ERROR: Entity '${entityName}' not found in service '${serviceId}'`
                    }],
                    isError: true
                };
            }

            // Set user token if requested and available
            if (useUserToken && this.userToken) {
                this.sapClient.setUserToken(this.userToken);
            } else {
                this.sapClient.setUserToken(undefined);
            }

            // Execute the operation
            let response;
            let operationDescription = "";

            switch (operation) {
                case 'read':
                    operationDescription = `Reading ${entityName} entities`;
                    if (queryOptions.$top) operationDescription += ` (top ${queryOptions.$top})`;
                    if (queryOptions.$filter) operationDescription += ` with filter: ${queryOptions.$filter}`;

                    response = await this.sapClient.readEntitySet(service.url, entityType.entitySet!, queryOptions, false);
                    break;

                case 'read-single': {
                    const keyValue = this.buildKeyValue(entityType, parameters);
                    operationDescription = `Reading single ${entityName} with key: ${keyValue}`;
                    response = await this.sapClient.readEntity(service.url, entityType.entitySet!, keyValue, false);
                    break;
                }

                case 'create':
                    if (!entityType.creatable) {
                        throw new Error(`Entity '${entityName}' does not support create operations`);
                    }
                    operationDescription = `Creating new ${entityName}`;
                    response = await this.sapClient.createEntity(service.url, entityType.entitySet!, parameters);
                    break;

                case 'update':
                    if (!entityType.updatable) {
                        throw new Error(`Entity '${entityName}' does not support update operations`);
                    }
                    {
                        const updateKeyValue = this.buildKeyValue(entityType, parameters);
                        const updateData = { ...parameters };
                        entityType.keys.forEach(key => delete updateData[key]);
                        operationDescription = `Updating ${entityName} with key: ${updateKeyValue}`;
                        response = await this.sapClient.updateEntity(service.url, entityType.entitySet!, updateKeyValue, updateData);
                    }
                    break;

                case 'delete':
                    if (!entityType.deletable) {
                        throw new Error(`Entity '${entityName}' does not support delete operations`);
                    }
                    {
                        const deleteKeyValue = this.buildKeyValue(entityType, parameters);
                        operationDescription = `Deleting ${entityName} with key: ${deleteKeyValue}`;
                        await this.sapClient.deleteEntity(service.url, entityType.entitySet!, deleteKeyValue);
                        response = { data: { message: `Successfully deleted ${entityName} with key: ${deleteKeyValue}`, success: true } };
                    }
                    break;

                default:
                    throw new Error(`Unsupported operation: ${operation}`);
            }

            let responseText = `SUCCESS: ${operationDescription}\n\n`;
            responseText += `== RESULT ==\n`;
            responseText += JSON.stringify(response.data, null, 2);

            return {
                content: [{
                    type: "text" as const,
                    text: responseText
                }]
            };

        } catch (error) {
            this.logger.error('Error executing entity operation:', error);
            return {
                content: [{
                    type: "text" as const,
                    text: `ERROR: Failed to execute ${args.operation} operation on ${args.entityName}: ${error instanceof Error ? error.message : String(error)}`
                }],
                isError: true
            };
        }
    }

    /**
     * Build key value for entity operations (handles single and composite keys)
     */
    private buildKeyValue(entityType: EntityType, parameters: Record<string, unknown>): string {
        const keyProperties = entityType.properties.filter(p => entityType.keys.includes(p.name));

        if (keyProperties.length === 1) {
            const keyName = keyProperties[0].name;
            if (!(keyName in parameters)) {
                throw new Error(`Missing required key property: ${keyName}. Required keys: ${entityType.keys.join(', ')}`);
            }
            return String(parameters[keyName]);
        }

        // Handle composite keys
        const keyParts = keyProperties.map(prop => {
            if (!(prop.name in parameters)) {
                throw new Error(`Missing required key property: ${prop.name}. Required keys: ${entityType.keys.join(', ')}`);
            }
            return `${prop.name}='${parameters[prop.name]}'`;
        });
        return keyParts.join(',');
    }

    /**
     * Register service metadata resources (unchanged from original)
     */
    public registerServiceMetadataResources(): void {
        this.mcpServer.registerResource(
            "sap-service-metadata",
            new ResourceTemplate("sap://service/{serviceId}/metadata", { list: undefined }),
            {
                title: "SAP Service Metadata",
                description: "Metadata information for SAP OData services"
            },
            async (uri, variables) => {
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

        // Register system instructions for Claude AI
        this.mcpServer.registerResource(
            "system-instructions",
            "sap://system/instructions",
            {
                title: "SAP MCP Server Instructions for Claude AI",
                description: "Comprehensive instructions for helping users interact with SAP OData services",
                mimeType: "text/markdown"
            },
            async (uri) => ({
                contents: [{
                    uri: uri.href,
                    text: this.getSystemInstructions(),
                    mimeType: "text/markdown"
                }]
            })
        );

        // Register authentication status resource
        this.mcpServer.registerResource(
            "authentication-status",
            "sap://auth/status",
            {
                title: "Authentication Status and Guidance",
                description: "Current authentication status and user guidance for OAuth flow",
                mimeType: "application/json"
            },
            async (uri) => {
                const authStatus = {
                    authentication: {
                        required: true,
                        configured: true, // XSUAA is configured
                        current_status: this.userToken ? 'authenticated' : 'not_authenticated',
                        token_present: !!this.userToken
                    },
                    user_context: this.userToken ? {
                        has_token: true,
                        message: 'User is authenticated and operations will use their SAP identity',
                        dual_auth_model: {
                            discovery: 'Uses technical user for service metadata discovery',
                            execution: 'Uses your JWT token for all data operations'
                        }
                    } : {
                        has_token: false,
                        message: 'User must authenticate before accessing SAP data',
                        action_required: 'OAuth authentication flow must be completed'
                    },
                    claude_ai_instructions: this.userToken ? {
                        status: 'READY',
                        message: 'User is authenticated. You can now help them access SAP data.',
                        workflow: [
                            'Call discover-sap-data ONCE with query - returns complete schemas',
                            'Immediately execute CRUD operations with execute-sap-operation using data from step 1',
                            'DO NOT call discover-sap-data multiple times with different queries'
                        ],
                        security_context: 'Operations execute under authenticated user identity'
                    } : {
                        status: 'AUTHENTICATION_REQUIRED',
                        message: 'CRITICAL: User must authenticate before you can help with SAP operations',
                        required_actions: [
                            'Guide user through OAuth authentication flow',
                            'Explain authentication is mandatory for SAP access',
                            'Provide clear step-by-step authentication instructions',
                            'Do NOT attempt SAP operations without authentication'
                        ],
                        oauth_flow_guidance: {
                            step1: 'Direct user to /oauth/authorize endpoint',
                            step2: 'User logs in with SAP BTP credentials',
                            step3: 'User copies access token from callback',
                            step4: 'User provides token to MCP client',
                            step5: 'Token is included in Authorization header for all requests'
                        }
                    },
                    endpoints: {
                        authorize: '/oauth/authorize',
                        callback: '/oauth/callback',
                        refresh: '/oauth/refresh',
                        userinfo: '/oauth/userinfo',
                        discovery: '/.well-known/oauth-authorization-server'
                    },
                    security_model: {
                        type: 'OAuth 2.0 with SAP XSUAA',
                        token_lifetime: '1 hour',
                        refresh_token_lifetime: '24 hours',
                        scope_based_authorization: true,
                        audit_trail: 'All operations logged under user identity'
                    }
                };

                return {
                    contents: [{
                        uri: uri.href,
                        text: JSON.stringify(authStatus, null, 2),
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
                        totalServices: this.discoveredServices.length,
                        categories: Array.from(new Set(Array.from(this.serviceCategories.values()).flat())),
                        services: this.discoveredServices.map(service => ({
                            id: service.id,
                            title: service.title,
                            description: service.description,
                            entityCount: service.metadata?.entityTypes?.length || 0,
                            categories: this.serviceCategories.get(service.id) || []
                        }))
                    }, null, 2)
                }]
            })
        );
    }

    /**
     * Generate comprehensive system instructions for AI assistants
     */
    private getSystemInstructions(): string {
        return `# SAP OData MCP Server - AUTHENTICATION REQUIRED

CRITICAL FOR AI ASSISTANTS: This server requires OAuth 2.0 authentication for all SAP operations.

== AUTHENTICATION STATUS CHECK ==

BEFORE HELPING USERS: Always check the authentication-status resource (sap://auth/status) to understand if the user is authenticated.

== MANDATORY AUTHENTICATION WORKFLOW ==

If user is NOT authenticated:
1. STOP - Do not attempt any SAP operations
2. GUIDE USER - Direct them to complete OAuth authentication first
3. EXPLAIN - Authentication is mandatory for SAP data access
4. PROVIDE INSTRUCTIONS - Step-by-step OAuth flow guidance

Authentication Requirements:
1. User must navigate to /oauth/authorize endpoint to get access token
2. User must include token in Authorization header: \`Bearer <token>\`
3. Server uses dual authentication model:
   - Discovery operations: Technical user (reliable metadata access)
   - Data operations: User's JWT token (proper authorization and audit trail)

== AVAILABLE TOOLS ==

You have access to 2 intelligent tools:

1. discover-sap-data (UNIVERSAL SEARCH - MAPPING TABLE IN ONE CALL)
- Purpose: Single tool for ALL discovery - services, entities, AND properties
- Returns: FLAT MAPPING TABLE with all entities and properties in ONE call
- Table Format: Each row contains Service ID, Service Name, Entity Name, Property Name, Property Type, Is Key, Capabilities
- Parameters:
  - query (REQUIRED): Search across services, entities, properties
  - category (optional): Filter by business area (business-partner, sales, finance, etc.)
  - limit (optional): Maximum services/entities to return (default: 10)
- Examples:
  - { query: "customer" } → Returns mapping table with ALL customer entity properties
  - { query: "email" } → Returns mapping table with all entities that have email properties
  - { query: "sales order", category: "sales" } → Returns mapping table for sales order entities
- ⚠️ CRITICAL: Returns EVERYTHING in ONE call - DO NOT call again with serviceId/entityName
- This ONE tool call gives you ALL the information you need in an easy-to-scan table format

2. execute-sap-operation
- Purpose: Perform CRUD operations on entities
- Parameters: serviceId, entityName, operation, parameters, OData options
- Operations: read, read-single, create, update, delete
- Use when: User wants to interact with actual data
- All data operations happen here

== RECOMMENDED WORKFLOW ==

⚠️ CRITICAL: discover-sap-data ALWAYS returns a COMPLETE MAPPING TABLE. NEVER call it twice for the same entity!

Recommended Workflow:
1. discover-sap-data with query → Returns FLAT MAPPING TABLE immediately with ALL data
2. Scan the mapping table to find the right entity and properties
3. execute-sap-operation → Use serviceId and entityName from the mapping table

⚠️ WRONG Workflow (DO NOT DO THIS):
1. discover-sap-data with query → Get mapping table
2. discover-sap-data with serviceId + entityName → This is REDUNDANT! Step 1 already included ALL properties!
3. execute-sap-operation → You wasted a call in step 2!

The discover-sap-data tool returns EVERYTHING you need in ONE MAPPING TABLE:
- Service IDs (for execute-sap-operation)
- Service Names (human-readable)
- Entity Names (for execute-sap-operation)
- ALL properties with types
- Key properties (marked in "Is Key" column)
- Capabilities (R:Y/N C:Y/N U:Y/N D:Y/N format)
- Property constraints (nullable, maxLength)

After calling discover-sap-data ONCE, scan the mapping table and proceed DIRECTLY to execute-sap-operation!

== BEST PRACTICES ==

Authentication Guidance:
- Always remind users about OAuth requirements
- If operations fail with auth errors, guide them to get a fresh token
- Explain that discovery uses technical user, operations use their credentials

Query Optimization:
- Use OData query options (filterString, selectString, topNumber) to limit data
- Encourage filtering to avoid large result sets
- Show users how to construct proper OData filters

Error Handling:
- If entity not found, suggest using discovery tools first
- For permission errors, explain JWT token requirements
- Guide users to check entity capabilities before operations

Natural Language Processing:
- Translate user requests into appropriate tool calls
- Break complex requests into multiple steps
- Explain what you're doing and why

== COMMON USER SCENARIOS ==

"Show me customer data"
1. discover-sap-data with query: "customer" → Returns MAPPING TABLE with all customer entities and properties
2. Scan the table to find the right customer entity
3. execute-sap-operation to read with serviceId and entityName from the table

"I need to update a customer's email"
1. discover-sap-data with query: "customer email" → Returns MAPPING TABLE showing entities with email property
2. Scan the table to find customer entity with email property
3. execute-sap-operation with operation: "update" using serviceId, entityName, and email property from table

"Create a new sales order"
1. discover-sap-data with query: "sales order" → Returns MAPPING TABLE with all sales order properties
2. Scan the table's Capabilities column to confirm creatable (C:Y)
3. Review all required properties in the mapping table
4. execute-sap-operation with operation: "create" using serviceId, entityName, and properties from table

"Find all entities with 'Status' property"
1. discover-sap-data with query: "status" → Returns MAPPING TABLE with all entities that have Status property
2. Scan the table to see all entities with Status property
3. Pick relevant entity from the table (serviceId and entityName are right there)
4. execute-sap-operation as needed using values from the table

== IMPORTANT REMINDERS ==

- Always authenticate first: Guide users through OAuth flow
- Respect entity capabilities: Don't attempt creates on read-only entities
- Use proper OData syntax: Help construct valid filters and selects
- Security context: Operations run under user's SAP credentials
- Token expiration: Tokens expire (typically 1 hour) - guide refresh

== YOUR ROLE ==

Act as an expert SAP consultant who:
- Understands business processes and data relationships
- Can translate business needs into technical operations
- Provides clear, step-by-step guidance
- Explains SAP concepts in user-friendly terms
- Ensures secure, authorized access to data

Remember: You're not just executing commands, you're helping users understand and work with their SAP data safely and effectively.`;
    }
}