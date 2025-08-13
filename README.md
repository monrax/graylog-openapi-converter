# Graylog OpenAPI spec

The current Graylog REST API documentation at `/api/api-docs` can be unreliable for development.
Some important details are missing that prevent it from becoming an authoritative reference, for
example: when is a given parameter truly required? what is a ViewDTO?, can the query field in a response for a given operation be null?
This forces developers into a trial-and-error process for many endpoints.

Moreover, the `/api/api-browser` UI renders docs from a live Graylog instance and does not allow downloading the complete spec for offline analysis.
It also relies on the older Swagger 1.2 format.

## Phases

This project aims addresses these issues in three phases:

1. **Convert** the currently available JSON docs to an equivalent YAML OpenAPI 3 spec. [✔]
   This will produce one resource to act as single source of truth, able to use modern doc rendering tools like redoc.
   Steps:
     a. Fetch JSON from a running Graylog 6.3 instance [✔]
     b. Parse spec from downloaded JSON and generate a single OpenAPI 3 spec file [✔]
     c. Generate a docs UI for the new spec [✔]
2. **Validate** the spec against a running Graylog cluster []
   This will help us ensure the spec matches reality by testing it against an actual Graylog instance, the same one that produced the JSON docs.
   Steps:
     a. Make a script to go through each endpoint one by one and identify errors [✔]
     b. Fix errors, run validations again. If the error doesn't show up anymore, make note of it as well as the fix for it []
        (If validation errors repeat across multiple endpoints, this should decrease the number of errors so that in the end we don't actually have to fix errors for each and every endpoint)
     c. Final test: attempt to develop something only using fixed spec with its rendered docs as single source of truth []
3. Contribute upstream []
   Share the improved specification with the Graylog community.
   Steps:
     a. Open issue in graylog2 repo []
     b. Modify swagger-based api docs rendering with openapi one in graylog's java codebase []
     c. Submit PR with the improvements []

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
