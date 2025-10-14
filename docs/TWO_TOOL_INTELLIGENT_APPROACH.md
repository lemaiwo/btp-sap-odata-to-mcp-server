# Two-Tool Intelligent Discovery Approach

## Overview

The hierarchical tool registry has been optimized to just **2 intelligent tools** with context-aware behavior and universal search capabilities. This is the ultimate simplification for AI assistants like Claude and Microsoft Copilot.

## The 2 Tools

### 1. discover-sap-data (Intelligent Universal Discovery)

**Single tool for ALL discovery needs** - searches across services, entities, AND properties with intelligent relevance scoring and context-aware detail levels.

#### Smart Behavior

The tool automatically adapts its response based on parameters:

| Parameters | Behavior | Detail Level | Use Case |
|------------|----------|--------------|----------|
| `query` | Search across everything | **Summary** | "Find customer email" |
| `serviceId` | Show entities in service | **Summary** | Browse service contents |
| `serviceId + entityName` | Get entity schema | **Full** | Ready to execute operations |
| `query + includeFullSchema: true` | Search with full details | **Full** | Need complete schemas in search |

#### Parameters

```typescript
{
  query?: string,              // Search term (services, entities, properties)
  category?: string,           // Filter: business-partner, sales, finance, etc.
  serviceId?: string,          // Direct service access
  entityName?: string,         // Direct entity access (requires serviceId)
  includeFullSchema?: boolean, // Force full schema in searches
  limit?: number               // Max results (default: 10)
}
```

#### Intelligence Features

**1. Multi-Level Search**
- Searches service names, titles, descriptions
- Searches entity names across all services
- Searches property names within entities
- Returns matches sorted by relevance score

**2. Relevance Scoring**
```
Score 0.95: Entity name exact match
Score 0.90: Service ID match
Score 0.85: Service title match
Score 0.75: Property name match
Score 0.70: Service description match
```

**3. Match Types**
- **service**: Service-level match
- **entity**: Entity name match
- **property**: Property name match within entity

**4. Context-Aware Details**
- Search mode → Summary (efficient, ~5KB per 5 matches)
- Direct access → Full schema (~50KB, complete information)
- Override with `includeFullSchema: true` when needed

#### Examples

**Search for anything related to "customer":**
```javascript
{
  query: "customer"
}
// Returns:
// - Services with "customer" in name/description
// - Entities named "Customer", "CustomerMaterial", etc.
// - Entities with properties like "CustomerID", "CustomerName"
// All with relevance scores
```

**Find entities with "email" property:**
```javascript
{
  query: "email"
}
// Returns entities across ALL services that have:
// - "Email", "EmailAddress", "CustomerEmail", etc. properties
```

**Get full entity schema in ONE call:**
```javascript
{
  serviceId: "API_BUSINESS_PARTNER",
  entityName: "Customer"
}
// Returns complete schema with all properties, types, keys
```

**Browse service contents:**
```javascript
{
  serviceId: "API_SALES_ORDER_SRV"
}
// Returns service info + all entities (summary)
```

### 2. execute-sap-operation

**Unchanged from previous versions** - performs CRUD operations on discovered entities.

## Why 2 Tools is Optimal

### Previous Approaches

- **200+ tools**: One CRUD tool per entity (token overflow)
- **4 tools**: Separate search, discover, schema, execute (good but can be simpler)
- **3 tools**: Combined search+discover (better but still separate schema)
- **2 tools**: Universal intelligent discovery (optimal!)

### Benefits of 2-Tool Approach

**For AI Assistants:**
✅ Simplest possible tool selection (only 2 choices)
✅ One tool handles ALL discovery scenarios
✅ Natural language search works out of the box
✅ Don't need to know SAP structure upfront
✅ Relevance scores guide decisions

**For Users:**
✅ Discover by what they know (concepts, property names)
✅ "Find entities with email property" just works
✅ Faster workflows (fewer tool calls)
✅ More intuitive interaction model

**For Microsoft Copilot:**
✅ Fewer tools = dramatically better tool selection
✅ Clear decision: discover first, then execute
✅ All Copilot optimizations preserved:
  - No emojis
  - String types (no enums)
  - Flattened parameters
  - Detailed OData syntax guidance

## Typical Workflows

### Workflow 1: Semantic Search

**User**: "I need to update a customer's email address"

```
1. discover-sap-data({ query: "customer email" })
   → AI sees entities with both "customer" and "email" properties
   → Relevance scores help pick the right entity

2. discover-sap-data({
     serviceId: "API_BUSINESS_PARTNER",
     entityName: "Customer"
   })
   → Gets full schema with Email property details

3. execute-sap-operation({
     serviceId: "API_BUSINESS_PARTNER",
     entityName: "Customer",
     operation: "update",
     parameters: { CustomerID: "123", Email: "new@email.com" }
   })
```

### Workflow 2: Direct Access (Fast Path)

**User**: "Show me the customer schema"

```
1. discover-sap-data({
     serviceId: "API_BUSINESS_PARTNER",
     entityName: "Customer"
   })
   → Single call gets full schema

2. execute-sap-operation(...)
   → Ready to execute
```

### Workflow 3: Exploratory Discovery

**User**: "What sales data is available?"

```
1. discover-sap-data({ category: "sales" })
   → Shows all sales-related services and entities

2. Pick interesting entity from results

3. discover-sap-data({ serviceId: "...", entityName: "..." })
   → Get full details

4. execute-sap-operation(...)
```

### Workflow 4: Property-Based Discovery

**User**: "Which entities have a 'Status' field?"

```
1. discover-sap-data({ query: "status" })
   → Returns ALL entities across ALL services with Status property
   → Shows which service each entity belongs to
   → Relevance scores indicate best matches

2. Select relevant entity

3. execute-sap-operation(...)
```

## Response Format

### Search Mode Response (Summary)

```json
{
  "query": "customer email",
  "category": "all",
  "totalFound": 5,
  "showing": 5,
  "detailLevel": "summary",
  "matches": [
    {
      "type": "entity",
      "score": 0.95,
      "service": {
        "id": "API_BUSINESS_PARTNER",
        "title": "Business Partner API"
      },
      "entity": {
        "name": "Customer",
        "keyProperties": ["CustomerID"],
        "propertyCount": 25,
        "propertyNames": ["CustomerID", "Name", "Email", "Address", ...],
        "matchedProperties": ["Email"],
        "capabilities": {
          "readable": true,
          "creatable": true,
          "updatable": true,
          "deletable": false
        }
      },
      "matchReason": "Entity 'Customer' matches 'customer'"
    },
    {
      "type": "property",
      "score": 0.75,
      "service": {
        "id": "API_SALES_ORDER_SRV",
        "title": "Sales Order API"
      },
      "entity": {
        "name": "SalesOrder",
        "keyProperties": ["SalesOrderID"],
        "propertyCount": 30,
        "propertyNames": ["SalesOrderID", "CustomerID", "CustomerEmail", ...],
        "matchedProperties": ["CustomerID", "CustomerEmail"],
        "capabilities": { ... }
      },
      "matchReason": "Properties [CustomerID, CustomerEmail] match 'customer'"
    }
  ]
}
```

### Direct Access Response (Full Schema)

```json
{
  "entity": {
    "name": "Customer",
    "entitySet": "CustomerSet",
    "namespace": "API_BUSINESS_PARTNER"
  },
  "capabilities": {
    "readable": true,
    "creatable": true,
    "updatable": true,
    "deletable": false
  },
  "keyProperties": ["CustomerID"],
  "properties": [
    {
      "name": "CustomerID",
      "type": "Edm.String",
      "nullable": false,
      "maxLength": 10,
      "isKey": true
    },
    {
      "name": "Email",
      "type": "Edm.String",
      "nullable": true,
      "maxLength": 100,
      "isKey": false
    }
    // ... all properties
  ]
}
```

## Performance Characteristics

### Token Efficiency

| Scenario | Detail Level | Typical Size | Tokens |
|----------|--------------|--------------|--------|
| Search 5 matches | Summary | ~5KB | ~1,250 |
| Search 10 matches | Summary | ~10KB | ~2,500 |
| Single entity schema | Full | ~50KB | ~12,500 |
| Search with full schema | Full | ~250KB | ~62,500 |

**Recommendation**: Use summary for searches, full for direct access

### API Call Efficiency

| Old Approach (4 tools) | New Approach (2 tools) |
|------------------------|------------------------|
| 1. Search services     | 1. Search everything   |
| 2. Get entities        | 2. Get schema          |
| 3. Get schema          | 3. Execute             |
| 4. Execute             |                        |
| **4 calls**            | **3 calls** (or 2!)    |

## Best Practices

### 1. Start with Search

```javascript
// Good: Find what you need first
discover-sap-data({ query: "what I'm looking for" })

// Then drill down
discover-sap-data({ serviceId: "...", entityName: "..." })
```

### 2. Use Relevance Scores

```javascript
// The tool returns matches sorted by score
// Higher score = better match
// Pick the top matches for your use case
```

### 3. Trust the Intelligence

```javascript
// Don't overthink parameters
// The tool automatically knows:
// - Search mode vs direct access
// - Summary vs full schema
// - When to include what details
```

### 4. Leverage Property Search

```javascript
// Don't know which service has customer data?
discover-sap-data({ query: "customer" })

// Don't know which entity has email?
discover-sap-data({ query: "email" })

// Need entities with status field?
discover-sap-data({ query: "status" })
```

### 5. Use includeFullSchema Sparingly

```javascript
// Only when you need full schemas in search results
// Default summary is usually sufficient
discover-sap-data({
  query: "customer",
  includeFullSchema: true  // Use only when really needed
})
```

## Migration Guide

### From 4-Tool Approach

**Old:**
```javascript
// Step 1
search-sap-services({ category: "sales" })

// Step 2
discover-service-entities({ serviceId: "..." })

// Step 3
get-entity-schema({ serviceId: "...", entityName: "..." })

// Step 4
execute-entity-operation(...)
```

**New:**
```javascript
// Step 1 & 2 combined
discover-sap-data({ query: "sales" })

// Step 2 (if needed)
discover-sap-data({ serviceId: "...", entityName: "..." })

// Step 3
execute-sap-operation(...)
```

### From 3-Tool Approach

**Old:**
```javascript
discover-sap-services({ query: "..." })
discover-sap-services({ serviceId: "..." })
get-entity-schema({ serviceId: "...", entityName: "..." })
```

**New:**
```javascript
discover-sap-data({ query: "..." })
discover-sap-data({ serviceId: "...", entityName: "..." })
// That's it - schema included automatically!
```

## AI Assistant Guidance

### For Claude AI

Claude excels with the 2-tool approach:
- Understands semantic search naturally
- Interprets relevance scores well
- Makes good decisions about when to get full schema
- Chains calls efficiently

### For Microsoft Copilot

The 2-tool approach is specifically optimized for Copilot:
- Simplest possible tool selection
- Clear workflow: discover → execute
- All Copilot compatibility features included
- Natural language queries work perfectly

### For All AI Assistants

The universal discovery pattern works across all platforms:
- One tool to learn
- Predictable behavior
- Clear decision points
- Excellent results

## Summary

The 2-tool intelligent approach provides:

✅ **Simplest** - Only 2 tools, can't get simpler
✅ **Smartest** - Context-aware, relevance scoring, multi-level search
✅ **Fastest** - Fewer calls, intelligent caching
✅ **Most Powerful** - Search across everything simultaneously
✅ **Best for AI** - Optimal for both Claude and Copilot
✅ **Future-Proof** - Extensible, maintainable architecture

This is the recommended approach for all new implementations.
