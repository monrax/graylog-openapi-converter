# Graylog OpenAPI spec

```
The current Graylog REST API documentation at /api/api-docs can be unreliable for development.

Some important details are missing that prevent it from becoming an authoritative reference.

For example:
  - when is a given parameter truly required and which ones are truly optional?
  - what is a ViewDTO?
  - can the query field in a response for a given operation be null?
  - etc.

This forces developers into a trial-and-error process for many endpoints.

Moreover, the /api/api-browser UI renders docs from a live Graylog instance, which may unavailable for offline analysis.
The UI does not allow downloading the complete spec, and it also relies on the older Swagger 1.2 format.
```

## Phases

```
This project aims addresses these issues in three phases:

1. [✔] ͟C͟o͟n͟v͟e͟r͟t͟ the currently available JSON docs to an equivalent YAML OpenAPI 3 spec.

   This will produce one resource to act as single source of truth, able to use modern doc rendering tools like redoc.

   Steps:
     a. [✔] Fetch JSON from any live Graylog instance running Graylog 6.3.
     b. [✔] Parse spec from downloaded JSON and generate a single OpenAPI 3 spec file.
     c. [✔] Generate a docs UI for the new OpenAPI 3 spec.

3. [ ] ͟V͟a͟l͟i͟d͟a͟t͟e͟ the spec against a running Graylog cluster.

   This will produce a spec that matches reality by testing it against the same instance that produced the JSON docs.

   Steps:
     a. [✔] Make a script to go through each endpoint and identify errors one by one.
     b. [ ] Perform this process iteratively:
               - Apply patch to fix spec error, run validations again.
               - If the error keeps showing up, rollback.
               - If the error doesn't show up anymore, make note of it as well as the fix for it.
            If validation errors repeat across multiple endpoints, this should decrease the overall number of errors.
            If all errors are systematic, and each endpoint doesn't have a unique error, we should have a spec before having iterated through all endpoints/operations.
     c. [ ] Final test: attempt to develop something (?) only using valid spec with its rendered docs as reference.

4. [ ] ͟C͟o͟n͟t͟r͟i͟b͟u͟t͟e͟ upstream.

   Share the improved specification with the Graylog community.

   Steps:
     a. [ ] Open issue in graylog2 repo with findings from the validation process.
     b. [ ] Replace swagger-based api docs rendering with openapi one in graylog codebase.
     c. [ ] Submit PR with the improvements.
```
---

## Directory structure

```
README.md
LICENSE
converter
|-README.md
|-package.json
|-package-lock.json
|-scripts
  |-all.js
  |-combine-openapi.js
  |-fetch-swagger.js
  |-generate-openapi.js
validator
|-README.md
|-requirements.txt
|-spec-validator.py
|-mcp
  |-README.md
  |-spec-validator-mcp.py
```
