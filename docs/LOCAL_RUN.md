# Running the MCP Server Locally

You can run the MCP server locally (in VS Code, SAP Business Application Studio, or any environment) using a `default-env.json` file for service credentials. Optionally, you can use a `.env` file to override the destination name.

## Configuration Steps

1. Copy `example-default-env.json` to `default-env.json` in your project root.
2. Fill in the placeholders with the credentials for your:
   - **Destination service instance**
   - **Connectivity service instance**
   - **XSUAA service instance** (currently not used, but planned for future authentication support)

## Optional: Override Destination Name with .env

If you want to use a different destination than `SAP_SYSTEM`, create a `.env` file in your project root and set:

```env
SAP_DESTINATION_NAME=MY_DESTINATION
```

You can also set any service discovery environment variables described in the main documentation.

## Run Locally Without BTP (env destinations)

You can run fully locally without BTP Destination/Connectivity by providing a destination via environment variables. Your machine must be able to reach the SAP host/port directly (VPN as needed); Cloud Connector is not used in this mode.

### Option A: .env (recommended)
```env
SAP_DESTINATION_NAME=S4
destinations=[{"name":"S4","url":"https://<URL>:<PORT>","username":"<USER>","password":"<PASSWORD>"}]
# If your system uses self-signed TLS certificates (local only):
# NODE_TLS_REJECT_UNAUTHORIZED=0
# Optional logging:
# LOG_LEVEL=debug
```

### Option B: one-off in your shell
```bash
export SAP_DESTINATION_NAME=S4
export destinations='[{"name":"S4","url":"https://<host>:<port>","username":"<user>","password":"<pass>"}]'
# If needed for self-signed TLS:
# export NODE_TLS_REJECT_UNAUTHORIZED=0
```

Notes:
- The default destination name is `SAP_SYSTEM`. Either set `SAP_DESTINATION_NAME` or make the JSON `name` match `SAP_SYSTEM`.
- The server accepts `destinations` or `DESTINATIONS`. If exactly one destination is provided, it will be used automatically.
- If XSUAA is not configured in VCAP (local), OAuth is disabled and the server runs without a token requirement.

Verify after start:
- Health: `http://localhost:3000/health`
- MCP info: `http://localhost:3000/mcp`

Troubleshooting:
- If you see messages about missing destination service bindings, ensure `destinations`/`DESTINATIONS` is set in your environment or `.env`.
```

## Running the Server

After configuration, start the server with:

```bash
npm run start:http
```


## ⚙️ Environment Variable: Disable ReadEntity Tool Registration

To disable registration of the ReadEntity tool for all entities in all services, set the following in your `.env` file:

```env
DISABLE_READ_ENTITY_TOOL=true
```
This will prevent registration of the ReadEntity tool for all entities and services.

- The XSUAA configuration is present for future authentication support, but is not currently used.
- You can combine these environment variables with any service discovery configuration described in `SERVICE_DISCOVERY_CONFIG.md`.
- For more advanced configuration, see the main documentation.
