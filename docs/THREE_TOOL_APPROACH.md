# Three-Tool Hierarchical Approach

## Overview

The hierarchical tool registry has been optimized from 4 tools down to 3 tools for better AI assistant compatibility, especially for Microsoft Copilot. This simplification makes tool selection easier while maintaining all functionality.

## The 3 Tools

### 1. discover-sap-services (Unified Discovery)

**Purpose:** Single entry point for both service search and entity discovery

**Parameters:**
- `query` (optional) - Search term for services
- `category` (optional) - Filter by business area (sales, finance, etc.)
- `serviceId` (optional) - When provided, returns entities for this service
- `showCapabilities` (optional) - Show CRUD capabilities
- `limit` (optional) - Limit number of services returned

**Behavior:**
- **Without `serviceId`**: Searches and returns matching services
- **With `serviceId`**: Returns all entities within that service

**Examples:**
```javascript
// Search for services
{
  "category": "sales",
  "limit": 10
}

// Get entities in a service
{
  "serviceId": "API_SALES_ORDER_SRV"
}
```

### 2. get-entity-schema

**Purpose:** Get detailed schema information for a specific entity

**Parameters:**
- `serviceId` (required) - The service ID
- `entityName` (required) - The entity name

**Returns:** Detailed property information, keys, types, constraints, and capabilities

### 3. execute-sap-operation

**Purpose:** Perform CRUD operations on entities

**Parameters:**
- `serviceId` (required)
- `entityName` (required)
- `operation` (required) - read, read-single, create, update, delete
- `parameters` (optional) - Keys and data
- `filterString` (optional) - OData $filter value
- `selectString` (optional) - OData $select value
- `expandString` (optional) - OData $expand value
- `orderbyString` (optional) - OData $orderby value
- `topNumber` (optional) - OData $top value
- `skipNumber` (optional) - OData $skip value

## Why 3 Tools Instead of 4?

### Previous 4-Tool Structure
1. search-sap-services
2. discover-service-entities
3. get-entity-schema
4. execute-entity-operation

### New 3-Tool Structure
1. **discover-sap-services** (combines tools 1 & 2)
2. get-entity-schema
3. execute-sap-operation (renamed from execute-entity-operation)

### Benefits

1. **Simpler Mental Model**
   - One tool for all discovery (services + entities)
   - One tool for detailed schema (optional)
   - One tool for operations

2. **Better for AI Assistants**
   - Fewer tools = easier tool selection
   - Natural workflow: discover → (optional schema) → execute
   - Reduces decision complexity for Copilot

3. **More Intuitive**
   - Services and their entities belong together conceptually
   - Single discovery flow instead of two separate steps
   - Clear progression from discovery to execution

4. **Maintains All Functionality**
   - Nothing is lost - just reorganized
   - Same capabilities, simpler interface
   - Backward compatible through unified method

## Typical Workflows

### Workflow 1: Simple Data Read

```
1. discover-sap-services (find services)
   → category: "sales"

2. discover-sap-services (get entities)
   → serviceId: "API_SALES_ORDER_SRV"

3. execute-sap-operation (read data)
   → operation: "read"
   → filterString: "Status eq 'Open'"
```

### Workflow 2: Create New Entity

```
1. discover-sap-services
   → category: "sales"

2. discover-sap-services
   → serviceId: "API_SALES_ORDER_SRV"

3. get-entity-schema (optional but recommended)
   → entityName: "SalesOrder"

4. execute-sap-operation
   → operation: "create"
   → parameters: { ... required fields ... }
```

### Workflow 3: Quick Update

```
1. discover-sap-services
   → serviceId: "KNOWN_SERVICE_ID"

2. execute-sap-operation
   → operation: "update"
   → parameters: { key: "123", Status: "Completed" }
```

## AI Assistant Guidance

### For Claude AI

Claude handles the 3-tool structure excellently:
- Understands the unified discovery pattern
- Can efficiently chain tool calls
- Makes good decisions about when schema is needed

### For Microsoft Copilot

The 3-tool structure is specifically optimized for Copilot:
- Simpler tool selection with fewer options
- Clear workflow progression
- All Copilot-specific optimizations apply:
  - No emojis in descriptions
  - String types instead of enums
  - Flattened parameters (no nested objects)
  - Detailed OData syntax guidance

## Migration from 4-Tool Structure

If you have existing code or workflows using the old 4-tool structure:

### Old Tool Names → New Tool Names

- `search-sap-services` → `discover-sap-services` (without serviceId)
- `discover-service-entities` → `discover-sap-services` (with serviceId)
- `get-entity-schema` → `get-entity-schema` (unchanged)
- `execute-entity-operation` → `execute-sap-operation` (renamed)

### Code Examples

**Old approach:**
```javascript
// Step 1: Search
await callTool("search-sap-services", {
  category: "sales"
});

// Step 2: Get entities
await callTool("discover-service-entities", {
  serviceId: "API_SALES_ORDER_SRV"
});
```

**New approach:**
```javascript
// Step 1: Search
await callTool("discover-sap-services", {
  category: "sales"
});

// Step 2: Get entities
await callTool("discover-sap-services", {
  serviceId: "API_SALES_ORDER_SRV"
});
```

## Performance & Efficiency

The 3-tool approach is just as efficient as the 4-tool approach:

- **Same number of API calls** - No additional overhead
- **Same data returned** - No information lost
- **Better caching** - Unified tool can cache more effectively
- **Faster AI decisions** - Less time choosing between tools

## Best Practices

1. **Always start with discovery**
   ```javascript
   discover-sap-services → discover-sap-services → execute-sap-operation
   ```

2. **Use schema when needed**
   - For create/update operations
   - When field requirements are unclear
   - For understanding relationships

3. **Leverage the unified tool**
   - Don't hesitate to call discover-sap-services multiple times
   - It's designed for this pattern
   - Results are the same whether called once or twice

4. **Provide clear parameters**
   - Use serviceId for entity listing
   - Use category for service search
   - Don't mix search and entity parameters

## Summary

The 3-tool hierarchical approach provides:

✅ **Simpler** - Fewer tools to choose from
✅ **Clearer** - Obvious workflow progression
✅ **Optimized** - Better for AI assistants like Copilot
✅ **Complete** - All functionality preserved
✅ **Compatible** - Works with all MCP clients

This is the recommended approach for all new implementations and integrations.
