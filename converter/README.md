# Graylog OpenAPI Generator

This toolkit converts Graylog's Swagger 1.2 API documentation into a modern OpenAPI 3.0 specification.

## Prerequisites

- Node.js **14.0.0 or higher**  
- npm or yarn  
- A Graylog instance accessible from where you run this tool  

## Installation

```bash
# Install dependencies
npm install

# Or using yarn
yarn install
```

## Usage

If you want to do everything (fetch, generate, combine, and build docs) in one go, run:
```
npm run all -- "http://admin:admin123@mygraylog:9000/"
```

> [!NOTE]
> The `all` script will:
> 1.	Clean previous generated files
> 2.	Fetch the latest Swagger endpoints from Graylog
> 3.	Generate modular OpenAPI YAML files
> 4.	Combine them into a single YAML spec
> 5.	Build HTML documentation

### Output Files

| File/Directory | Size | Description |
|----------------|------|-------------|
| `graylog-swagger-endpoints.json` | ~970 KB | Array of current Graylog API endpoint groups |
| `graylog-api/` | ~2.3 MB total | Modular specification |
| `graylog-api/openapi.yaml` | ~150 KB | Main file with $refs to all paths and schemas |
| `graylog-api/paths/*.yaml` | 60-320 KB each | Domain-specific endpoints |
| `graylog-api/schemas/*.yaml` | 80-320 KB each | Schema definitions |
| `graylog-openapi-combined.yaml` | ~2.3 MB | Single combined file |
| `docs.html` | ~14 MB | Static HTML docs rendered using [Redocly](https://github.com/Redocly/redoc) |

To view the generated docs:
```
open docs.html
```

---

If you'd rather do each step one by one, here's how to do that:

<details closed>
<summary><code>fetch</code></summary>

### Fetching Graylog API Endpoints

The first step is to fetch the full list of Swagger 1.2 endpoint specs from your Graylog instance.
You can pass the base URL including credentials (if required) in the form:
```
http://<username>:<password>@<graylog-host>:<port>/
```
Example:
```
npm run fetch -- "http://admin:admin123@mygraylog:9000/"
```
This will:

	•	Request /api/api-docs from Graylog
	•	Discover each individual Swagger endpoint
	•	Fetch them all in parallel (with a live progress counter)
	•	Save them into graylog-swagger-endpoints.json in the project root

</details>

<details closed>
<summary><code>generate</code></summary>
	
### Generating Modular OpenAPI Files

Once you’ve fetched the Graylog endpoints:
```
npm run generate
```

This creates a `graylog-api/` directory with the following structure:
```
graylog-api/
├── openapi.yaml                # Main specification with individual $refs
├── paths/                      # Domain-organized path definitions
│   ├── core-system.yaml          # 251 system endpoints
│   ├── core-streams.yaml         # 28 stream endpoints
│   ├── core-search.yaml          # 34 search endpoints
│   ├── core-events.yaml          # 26 event endpoints
│   ├── core-users.yaml           # 26 user endpoints
│   ├── core-inputs.yaml          # ~25 input endpoints
│   ├── core-dashboard.yaml       # 9 dashboard endpoints
│   ├── plugin-archive.yaml       # 34 archive plugin endpoints
│   ├── plugin-security.yaml      # 156 security plugin endpoints
│   ├── plugin-illuminate.yaml    # 31 illuminate plugin endpoints
│   ├── plugin-integrations.yaml  # 46 integration endpoints
│   ├── plugin-datawarehouse.yaml # 30 data warehouse endpoints
│   ├── plugin-forwarder.yaml     # 18 forwarder endpoints
│   ├── plugin-license.yaml       # 16 license endpoints
│   ├── plugin-reports.yaml       # 25 report endpoints
│   ├── plugin-sidecar.yaml       # 23 sidecar endpoints
│   └── misc-admin.yaml           # 91 miscellaneous admin endpoints
└── schemas/                    # Schema definitions
    ├── core-schemas.yaml         # Core API schemas
    ├── plugin-schemas.yaml       # Plugin schemas
    └── common-schemas.yaml       # Shared schemas
```
</details>

<details closed>
<summary><code>combine</code></summary>

### Combining Into a Single OpenAPI Spec

To merge the modular files into one large OpenAPI file:
```
npm run combine
```

This creates a single `graylog-openapi-combined.yaml` file (~2.3 MB) containing the complete specification.

</details>

<details closed>
<summary><code>build-docs</code></summary>
	
### Building HTML Docs

To render HTML API docs using Redocly CLI:
```
npm run build-docs
```
This outputs `docs.html` in the project root.

</details>


## Cleanup

To remove all generated files:
```
npm run clean
```
To remove everything, including the fetched `graylog-swagger-endpoints.json`:
```
npm run cleanall
```

---

## Additional Notes

### Features

- ✅ Fetch Swagger 1.2 API docs directly from a Graylog instance  
- ✅ Converts all current API paths from Swagger 1.2 to OpenAPI 3.0  
- ✅ Generates modular YAML files organized by domain  
- ✅ Combines modular files into a single specification  
- ✅ Preserves all schema definitions  
- ✅ Proper parameter and response type mapping  
- ✅ Full support for authentication schemes and security definitions  
- ✅ Organized into manageable files (~60–320 KB each)  

### API Coverage

- **844 unique API paths**
- **1,065 total operations** (GET, POST, PUT, DELETE)
- **970+ schema definitions**
- **16 domain categories**

### Domain Categories

1. **Core APIs** (~375 paths)
   - System & Cluster Management (251)
   - Streams (28)
   - Search & Messages (34)
   - Events (26)
   - Users & Roles (26)
   - Dashboards (9)

2. **Plugin APIs** (~378 paths)
   - Security & Threat Intelligence (156)
   - Integrations (AWS, Azure, etc.) (46)
   - Archive Management (34)
   - Illuminate Content (31)
   - Data Warehouse (30)
   - Reports (25)
   - Sidecar Collectors (23)
   - Forwarder (18)
   - License Management (16)

3. **Administrative APIs** (~91 paths)
   - Miscellaneous admin operations

### Validation

The combine script includes basic validation:
- ✓ Checks for required OpenAPI fields
- ✓ Validates path definitions exist
- ✓ Verifies schema references are resolved
- ⚠ Warns about missing schema definitions

### Support

For Graylog API documentation, visit: https://docs.graylog.org/docs/rest-api

For OpenAPI specification details, visit: https://spec.openapis.org/oas/v3.0.3
