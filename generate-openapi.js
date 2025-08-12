#!/usr/bin/env node

/**
 * Generate Graylog OpenAPI 3.0 Specification from Swagger 1.2 data
 * 
 * Usage:
 *   node generate-openapi.js
 * 
 * Input files required:
 *   - graylog-swagger-endpoints.json
 * 
 * Output:
 *   - Complete OpenAPI 3.0 spec in ./graylog-api/ directory
 */

const fs = require('fs');
const path = require('path');
// Attempt to require js-yaml; fallback to simple JSON output (valid YAML subset) if unavailable
let yaml;
try {
  yaml = require('js-yaml');
} catch (e) {
  yaml = {
    dump: (obj, opts) => JSON.stringify(obj, null, 2),
    isFallback: true
  };
}

// Helper functions for hierarchical tags
// Titleize a path segment; preserve Java package segments containing dots
function titleize(seg) {
  if (!seg) return seg;
  // If segment contains a dot (Java package), return as-is without capitalizing or splitting
  if (seg.includes('.')) {
    return seg;
  }
  return seg
    .split(/[-_]/)
    .map(w => {
      if (/^[A-Z0-9]+$/.test(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

// Convert resourcePath to hierarchical tag (e.g., "/system/inputs" -> "System/Inputs")
function pathToHierTag(resourcePath) {
  if (!resourcePath) return '';
  const parts = resourcePath.split('/').filter(Boolean);
  return parts.map(titleize).join('/');
}

// Extract top-level group name from a hierarchical tag (e.g., "System/Inputs" -> "System")
function topLevelGroupName(hierTag) {
  return hierTag.split('/')[0] || '';
}

// Create output directories
const OUTPUT_DIR = './graylog-api';
const PATHS_DIR = path.join(OUTPUT_DIR, 'paths');
const SCHEMAS_DIR = path.join(OUTPUT_DIR, 'schemas');

// Ensure directories exist
[OUTPUT_DIR, PATHS_DIR, SCHEMAS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Domain categorization function
function categorizePath(path) {
  if (path.startsWith('/system/') || path.startsWith('/cluster/')) return 'core-system';
  if (path.startsWith('/streams')) return 'core-streams';
  if (path.startsWith('/search') || path.startsWith('/views/search') || path.startsWith('/messages')) return 'core-search';
  if (path.startsWith('/events')) return 'core-events';
  if (path.startsWith('/users') || path.startsWith('/roles') || path.startsWith('/authz')) return 'core-users';
  if (path.startsWith('/inputs')) return 'core-inputs';
  if (path.startsWith('/dashboards') || (path.startsWith('/views') && !path.includes('search'))) return 'core-dashboard';
  
  // Plugins
  if (path.includes('archive')) return 'plugin-archive';
  if (path.includes('security') || path.includes('investigations') || path.includes('teams')) return 'plugin-security';
  if (path.includes('illuminate') || path.includes('bundles')) return 'plugin-illuminate';
  if (path.includes('integrations') || path.includes('aws') || path.includes('azure') || 
      path.includes('crowdstrike') || path.includes('okta') || path.includes('mimecast')) return 'plugin-integrations';
  if (path.includes('datawarehouse') || path.includes('data_warehouse')) return 'plugin-datawarehouse';
  if (path.includes('forwarder')) return 'plugin-forwarder';
  if (path.includes('license')) return 'plugin-license';
  if (path.includes('report')) return 'plugin-reports';
  if (path.startsWith('/sidecar')) return 'plugin-sidecar';
  
  return 'misc-admin';
}

// Convert Swagger 1.2 parameter to OpenAPI 3.0
function convertParameter(param) {
  const converted = {
    name: param.name,
    description: param.description || ''
  };
  
  // Convert paramType to 'in'
  if (param.paramType === 'path') converted.in = 'path';
  else if (param.paramType === 'query') converted.in = 'query';
  else if (param.paramType === 'header') converted.in = 'header';
  else if (param.paramType === 'body') return null; // body params handled separately
  else converted.in = 'query'; // default
  
  converted.required = param.required || false;
  
  // Schema
  converted.schema = {
    type: mapSwaggerType(param.type || 'string')
  };
  
  if (param.defaultValue !== undefined) {
    converted.schema.default = param.defaultValue;
  }
  
  if (param.enum) {
    converted.schema.enum = param.enum;
  }
  
  return converted;
}

// Map Swagger 1.2 types to OpenAPI 3.0 types
function mapSwaggerType(swaggerType) {
  const typeMap = {
    'int': 'integer',
    'long': 'integer',
    'float': 'number',
    'double': 'number',
    'byte': 'string',
    'binary': 'string',
    'date': 'string',
    'dateTime': 'string',
    'password': 'string'
  };
  
  return typeMap[swaggerType] || swaggerType;
}

// Convert operation to OpenAPI 3.0 format
// Convert operation to OpenAPI 3.0 format
// Accept optional flatTag and hierarchical tag, deduplicate tags
function convertOperation(op, path, method, flatTag, hierTag) {
  const operation = {
    summary: op.summary || '',
    operationId: op.nickname || `${method}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`
  };
  
  if (op.notes) {
    operation.description = op.notes;
  }
  
  // Determine tags from provided flatTag and hierarchical tag, deduplicate
  operation.tags = [];
  if (flatTag) operation.tags.push(flatTag);
  if (hierTag) operation.tags.push(hierTag);
  operation.tags = Array.from(new Set(operation.tags));
  
  // Parameters
  if (op.parameters && op.parameters.length > 0) {
    const regularParams = op.parameters.filter(p => p.paramType !== 'body');
    const bodyParam = op.parameters.find(p => p.paramType === 'body');
    
    if (regularParams.length > 0) {
      operation.parameters = [];
      regularParams.forEach(param => {
        const converted = convertParameter(param);
        if (converted) {
          operation.parameters.push(converted);
        }
      });
    }
    
    if (bodyParam) {
      operation.requestBody = {
        required: bodyParam.required || false,
        content: {
          'application/json': {
            schema: bodyParam.type && bodyParam.type !== 'any' 
              ? { '$ref': `#/components/schemas/${bodyParam.type}` }
              : { type: 'object' }
          }
        }
      };
      
      if (bodyParam.description) {
        operation.requestBody.description = bodyParam.description;
      }
    }
  }
  
  // Responses
  operation.responses = {};
  
  // Pick a primary success code:
  // 1) prefer one explicitly present in responseMessages (200/201/202/204)
  // 2) otherwise fall back to sensible defaults
  const SUCCESS_SET = new Set(['200','201','202','204']);
  let successCodeFromSpec = undefined;
  if (Array.isArray(op.responseMessages)) {
    // keep the first success-ish code if present
    for (const rm of op.responseMessages) {
      const c = String(rm.code || '');
      if (SUCCESS_SET.has(c)) { successCodeFromSpec = c; break; }
    }
  }
  let successCode = successCodeFromSpec || '200';
  if (!successCodeFromSpec) {
    if (method === 'delete') successCode = '204';
    else if (method === 'put' && op.type === 'void') successCode = '204';
    else if (method === 'post' && !path.includes('{')) successCode = '201';
  }

  operation.responses[successCode] = {
    description: 'Successful response'
  };
  
  // Add response content if not a DELETE or void response
  if (successCode !== '204' && op.type !== 'void') {
    const produces = op.produces || ['application/json'];
    operation.responses[successCode].content = {};
    
    produces.forEach(mediaType => {
      operation.responses[successCode].content[mediaType] = {
        schema: op.type && op.type !== 'any'
          ? { '$ref': `#/components/schemas/${op.type}` }
          : { type: 'object' }
      };
    });
  }
 
  // Merge all responseMessages from Swagger (preserve specific descriptions)
  if (Array.isArray(op.responseMessages) && op.responseMessages.length > 0) {
    op.responseMessages.forEach(resp => {
      const code = String(resp.code);
      const message = resp.message || '';
      if (code === successCode) {
        // override the generic description for the chosen success response
        if (!operation.responses[code]) operation.responses[code] = {};
        operation.responses[code].description = message || operation.responses[code].description || 'Successful response';
      } else {
        // add other codes (typically errors) without content
        operation.responses[code] = { description: message };
      }
    });
  }

  return operation;
}

// Get tag name for category
function getTagForCategory(category) {
  const tagMap = {
    'core-system': 'System',
    'core-streams': 'Streams',
    'core-search': 'Search',
    'core-events': 'Events',
    'core-users': 'Users',
    'core-inputs': 'Inputs',
    'core-dashboard': 'Dashboards',
    'plugin-archive': 'Archive Plugin',
    'plugin-security': 'Security Plugin',
    'plugin-illuminate': 'Illuminate Plugin',
    'plugin-integrations': 'Integrations',
    'plugin-datawarehouse': 'Data Warehouse Plugin',
    'plugin-forwarder': 'Forwarder Plugin',
    'plugin-license': 'License Plugin',
    'plugin-reports': 'Reports Plugin',
    'plugin-sidecar': 'Sidecar Plugin',
    'misc-admin': 'Administration'
  };
  
  return tagMap[category] || 'Other';
}

// Convert Swagger 1.2 model to OpenAPI 3.0 schema
function convertModel(model) {
  const schema = {
    type: model.type || 'object'
  };
  
  if (model.properties) {
    schema.properties = {};
    Object.keys(model.properties).forEach(propName => {
      const prop = model.properties[propName];
      schema.properties[propName] = convertProperty(prop);
    });
  }
  
  if (model.required && Array.isArray(model.required)) {
    schema.required = model.required;
  }
  
  if (model.additional_properties) {
    if (typeof model.additional_properties === 'string') {
      schema.additionalProperties = { type: model.additional_properties };
    } else if (typeof model.additional_properties === 'object') {
      schema.additionalProperties = convertProperty(model.additional_properties);
    } else {
      schema.additionalProperties = true;
    }
  }
  
  if (model.items) {
    schema.items = convertProperty(model.items);
  }
  
  if (model.enum) {
    schema.enum = model.enum;
  }
  
  return schema;
}

// Convert property
function convertProperty(prop) {
  if (!prop) return { type: 'object' };
  
  const result = {};
  
  if (prop.$ref) {
    result.$ref = `#/components/schemas/${prop.$ref.split(':').pop()}`;
  } else if (prop.type === 'array') {
    result.type = 'array';
    if (prop.items) {
      result.items = convertProperty(prop.items);
    } else {
      result.items = { type: 'object' };
    }
  } else if (prop.type === 'object' || !prop.type) {
    result.type = 'object';
    if (prop.properties) {
      result.properties = {};
      Object.keys(prop.properties).forEach(key => {
        result.properties[key] = convertProperty(prop.properties[key]);
      });
    }
    if (prop.additional_properties) {
      result.additionalProperties = convertProperty(prop.additional_properties);
    }
  } else {
    result.type = mapSwaggerType(prop.type);
    if (prop.format) {
      result.format = prop.format;
    }
    if (prop.enum) {
      result.enum = prop.enum;
    }
    if (prop.default !== undefined) {
      result.default = prop.default;
    }
  }
  
  if (prop.description) {
    result.description = prop.description;
  }
  
  return result;
}

// Main processing function
function generateOpenAPI() {
  console.log('Loading Graylog endpoint data...');
  const endpointData = JSON.parse(fs.readFileSync('graylog-swagger-endpoints.json', 'utf8'));
  
  // Organize paths by domain
  const domainPaths = {};
  const allModels = {};
  // Collections for hierarchical tags and grouping
  const hierarchicalTags = new Map();
  const tagGroups = new Map();
  
  console.log('Processing endpoints...');
  endpointData.forEach(endpoint => {
    // Collect models
    if (endpoint.models) {
      Object.keys(endpoint.models).forEach(modelName => {
        allModels[modelName] = endpoint.models[modelName];
      });
    }

    // Register hierarchical tag based on resourcePath
    const hierTag = pathToHierTag(endpoint.resourcePath);
    if (hierTag) {
      const tagDesc = endpoint.description || endpoint.name || `Operations for ${hierTag}`;
      if (!hierarchicalTags.has(hierTag)) {
        hierarchicalTags.set(hierTag, { name: hierTag, description: tagDesc });
      }
      const group = topLevelGroupName(hierTag);
      if (group) {
        if (!tagGroups.has(group)) tagGroups.set(group, new Set());
        tagGroups.get(group).add(hierTag);
      }
    }
    
    // Process paths
    if (endpoint.apis) {
      endpoint.apis.forEach(api => {
        if (api.path && api.operations) {
          const category = categorizePath(api.path);
          
          if (!domainPaths[category]) {
            domainPaths[category] = {};
          }
          
          if (!domainPaths[category][api.path]) {
            domainPaths[category][api.path] = {};
          }
          
          api.operations.forEach(op => {
            const method = (op.method || 'GET').toLowerCase();
            // Determine flat and hierarchical tags for this operation
            const flatTag = getTagForCategory(category);
            // Determine hierarchical tag for this API path. Compute from endpoint.resourcePath
            let htag = pathToHierTag(endpoint.resourcePath);
            let finalHierTag;
            if (htag) {
              // Only include the hierarchical tag if it differs from the flat tag to avoid duplicate tags
              finalHierTag = (htag !== flatTag) ? htag : undefined;
            }
            domainPaths[category][api.path][method] = convertOperation(op, api.path, method, flatTag, finalHierTag);
          });
        }
      });
    }
  });
  
  // Generate schema files
  console.log('Generating schema files...');
  
  // Categorize schemas
  const coreSchemas = {};
  const pluginSchemas = {};
  const commonSchemas = {};
  
  Object.keys(allModels).forEach(modelName => {
    const model = allModels[modelName];
    
    // Categorize based on model name
    if (modelName.includes('plugin') || modelName.includes('Plugin')) {
      pluginSchemas[modelName] = convertModel(model);
    } else if (modelName.includes('Response') || modelName.includes('Request') || 
               modelName === 'Object' || modelName === 'anyMap' || modelName === 'integerMap') {
      commonSchemas[modelName] = convertModel(model);
    } else {
      coreSchemas[modelName] = convertModel(model);
    }
  });
  
  // Write schema files (support fallback JSON when js-yaml is unavailable)
  console.log(`  - core-schemas.yaml (${Object.keys(coreSchemas).length} schemas)`);
  {
    const header = `# schemas/core-schemas.yaml\n# Core API schema definitions\n\n`;
    let body;
    if (yaml.isFallback) {
      body = JSON.stringify({ components: { schemas: coreSchemas } }, null, 2);
    } else {
      body = `components:\n  schemas:\n` + yaml.dump({ components: { schemas: coreSchemas } }, { lineWidth: -1 }).replace('components:\n  schemas:\n', '');
    }
    fs.writeFileSync(path.join(SCHEMAS_DIR, 'core-schemas.yaml'), header + body);
  }
  console.log(`  - plugin-schemas.yaml (${Object.keys(pluginSchemas).length} schemas)`);
  {
    const header = `# schemas/plugin-schemas.yaml\n# Plugin schema definitions\n\n`;
    let body;
    if (yaml.isFallback) {
      body = JSON.stringify({ components: { schemas: pluginSchemas } }, null, 2);
    } else {
      body = `components:\n  schemas:\n` + yaml.dump({ components: { schemas: pluginSchemas } }, { lineWidth: -1 }).replace('components:\n  schemas:\n', '');
    }
    fs.writeFileSync(path.join(SCHEMAS_DIR, 'plugin-schemas.yaml'), header + body);
  }
  console.log(`  - common-schemas.yaml (${Object.keys(commonSchemas).length} schemas)`);
  {
    const header = `# schemas/common-schemas.yaml\n# Common/shared schema definitions\n\n`;
    let body;
    if (yaml.isFallback) {
      body = JSON.stringify({ components: { schemas: commonSchemas } }, null, 2);
    } else {
      body = `components:\n  schemas:\n` + yaml.dump({ components: { schemas: commonSchemas } }, { lineWidth: -1 }).replace('components:\n  schemas:\n', '');
    }
    fs.writeFileSync(path.join(SCHEMAS_DIR, 'common-schemas.yaml'), header + body);
  }
  
  // Generate main OpenAPI file
  console.log('Generating main OpenAPI file...');
  
  // Helper to escape JSON pointer path segments
  function escapeJsonPointer(path) {
    return path.replace(/~/g, '~0').replace(/\//g, '~1');
  }
  
  const mainSpec = {
    openapi: '3.0.3',
    info: {
      title: 'Graylog REST API',
      version: '6.3.2+667aca0',
      description: 'Graylog REST API Documentation\n\nThis API provides programmatic access to Graylog\'s log management platform, including stream management, search capabilities, system configuration, and various plugin functionalities.',
      contact: {
        name: 'Graylog Support',
        url: 'https://www.graylog.org'
      },
      license: {
        name: 'Apache 2.0',
        url: 'https://www.apache.org/licenses/LICENSE-2.0'
      }
    },
    servers: [
      {
        url: 'http://10.1.254.79:9000/api',
        description: 'Graylog API Server'
      }
    ],
    paths: {},
    components: {
      schemas: {}
    }
  };
  
  // Build paths section with individual $refs for each path
  const categories = Object.keys(domainPaths).sort();
  categories.forEach(category => {
    const paths = domainPaths[category];
    Object.keys(paths).sort().forEach(path => {
      // Each path gets its own $ref pointing to the domain file
      const escapedPath = escapeJsonPointer(path);
      mainSpec.paths[path] = {
        '$ref': `./paths/${category}.yaml#/paths/${escapedPath}`
      };
    });
  });
  
  // Build schemas section with individual $refs for each schema
  const coreSchemaNames = Object.keys(coreSchemas).sort();
  const pluginSchemaNames = Object.keys(pluginSchemas).sort();
  const commonSchemaNames = Object.keys(commonSchemas).sort();
  
  coreSchemaNames.forEach(schemaName => {
    const escapedName = escapeJsonPointer(schemaName);
    mainSpec.components.schemas[schemaName] = {
      '$ref': `./schemas/core-schemas.yaml#/components/schemas/${escapedName}`
    };
  });
  
  pluginSchemaNames.forEach(schemaName => {
    const escapedName = escapeJsonPointer(schemaName);
    mainSpec.components.schemas[schemaName] = {
      '$ref': `./schemas/plugin-schemas.yaml#/components/schemas/${escapedName}`
    };
  });
  
  commonSchemaNames.forEach(schemaName => {
    const escapedName = escapeJsonPointer(schemaName);
    mainSpec.components.schemas[schemaName] = {
      '$ref': `./schemas/common-schemas.yaml#/components/schemas/${escapedName}`
    };
  });
  
  // Build tags and x-tagGroups, compute x-displayName and x-traitTag, and add logo
  // Gather flat tag names from categories
  const flatTagNames = new Set();
  categories.forEach(cat => {
    const name = getTagForCategory(cat);
    flatTagNames.add(name);
  });
  // Helper to compute display name for tags
  function computeDisplayName(tagName) {
    const segs = tagName.split('/').filter(Boolean);
    const base = [];
    const params = [];
    for (const seg of segs) {
      // Parameter segment like "{id}" or "{path: .*}" (allow spaces/regex)
      const paramMatch = seg.match(/^\{([^}]+)\}$/);
      if (paramMatch) {
        // Keep only the param name before an optional colon
        const name = paramMatch[1].split(':')[0].trim();
        if (name) params.push(name);
        continue;
      }
      // Non-parameter: if Java package, show only last component; otherwise keep as-is
      if (seg.includes('.')) {
        const last = seg.split('.').pop();
        base.push(last);
      } else {
        base.push(seg);
      }
    }
    let display = base.join('/');
    if (params.length) {
      display += ' by ' + params.map(p => p).join(' and by ');
    }
    // Uppercase certain initialisms and adjust AuthZ casing
    const replacements = {
      'ca': 'CA',
      'api': 'API',
      'http': 'HTTP',
      'aws': 'AWS',
      'cgp': 'CGP',
      'mitre': 'MITRE',
      'saml': 'SAML',
      'rest': 'REST',
      'authz': 'AuthZ'
    };
    const re = new RegExp(`\\b(${Object.keys(replacements).join('|')})\\b`, 'gi');
    display = display.replace(re, (match) => replacements[match.toLowerCase()]);
    return display;
  }
  const tagsArray = [];
  const usedNames = new Set();
  // Add flat tags
  flatTagNames.forEach(name => {
    if (!usedNames.has(name)) {
      const tagObj = { name: name, description: `${name} operations` };
      tagObj['x-displayName'] = computeDisplayName(name);
      // Determine traitTag: if group has single hierarchical tag and no further tags? For flat tags we skip traitTag
      tagsArray.push(tagObj);
      usedNames.add(name);
    }
  });
  // Add hierarchical tags
  hierarchicalTags.forEach((obj, name) => {
    if (!usedNames.has(name)) {
      const tagObj = { name: obj.name, description: obj.description };
      tagObj['x-displayName'] = computeDisplayName(obj.name);
      // traitTag is not added in this version
      tagsArray.push(tagObj);
      usedNames.add(name);
    }
  });
  if (tagsArray.length > 0) {
    mainSpec.tags = tagsArray;
  }
  // Build x-tagGroups
  const xTagGroups = [];
  tagGroups.forEach((set, group) => {
    // Build a unique list of tags for each group. Include the group name first, then
    // each hierarchical tag (excluding duplicates) sorted lexically. This avoids
    // duplicating the group name if it also appears in the set.
    const tagSet = new Set();
    tagSet.add(group);
    set.forEach(t => {
      if (t !== group) tagSet.add(t);
    });
    const list = Array.from(tagSet).sort((a, b) => a.localeCompare(b));
    xTagGroups.push({ name: group, tags: list });
  });
  if (xTagGroups.length > 0) {
    mainSpec['x-tagGroups'] = xTagGroups;
  }
  // Add logo to info
  mainSpec.info['x-logo'] = {
    url: 'https://graylog.org/wp-content/uploads/2022/07/GrayLog_Logo_color-300x96.png',
    altText: 'Graylog logo'
  };

  // Write main file
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'openapi.yaml'),
    yaml.dump(mainSpec, { lineWidth: -1, quotingType: "'", forceQuotes: true })
  );
  
  // Generate path files
  console.log('Generating path files...');
  categories.forEach(category => {
    const pathCount = Object.keys(domainPaths[category]).length;
    console.log(`  - ${category}.yaml (${pathCount} paths)`);
    
    const pathSpec = {
      paths: domainPaths[category]
    };
    
    fs.writeFileSync(
      path.join(PATHS_DIR, `${category}.yaml`),
      `# paths/${category}.yaml\n# Generated from Graylog Swagger 1.2 specification\n# Contains ${pathCount} paths\n\n` +
      yaml.dump(pathSpec, { lineWidth: -1, noRefs: true })
    );
  }  );
  
  // Fix invalid references to primitive types in all files
  console.log('Fixing primitive type references...');
  const primitiveTypes = ['string', 'integer', 'number', 'boolean', 'array', 'object', 'any'];
  
  // Check all generated files for invalid refs to primitive types
  const allFiles = [
    ...categories.map(cat => path.join(PATHS_DIR, `${cat}.yaml`)),
    path.join(SCHEMAS_DIR, 'core-schemas.yaml'),
    path.join(SCHEMAS_DIR, 'plugin-schemas.yaml'),
    path.join(SCHEMAS_DIR, 'common-schemas.yaml')
  ];
  
  allFiles.forEach(filePath => {
    if (fs.existsSync(filePath)) {
      let content = fs.readFileSync(filePath, 'utf8');
      let modified = false;
      
      primitiveTypes.forEach(type => {
        const refPattern = new RegExp(`\\$ref: ['"]#/components/schemas/${type}['"]`, 'g');
        if (content.match(refPattern)) {
          content = content.replace(refPattern, `type: ${type}`);
          modified = true;
        }
      });
      
      if (modified) {
        fs.writeFileSync(filePath, content);
        console.log(`  Fixed primitive type references in ${path.basename(filePath)}`);
      }
    }
  });
  
  // Summary
  console.log('\n=== Generation Complete ===');
  console.log(`Total paths: ${Object.values(domainPaths).reduce((acc, paths) => acc + Object.keys(paths).length, 0)}`);
  console.log(`Total schemas: ${Object.keys(allModels).length}`);
  console.log(`Output directory: ${OUTPUT_DIR}`);
  console.log('\nFile structure:');
  console.log('  openapi.yaml (with individual $refs for each path and schema)');
  console.log('  paths/');
  categories.forEach(category => {
    const pathCount = Object.keys(domainPaths[category]).length;
    console.log(`    ${category}.yaml (${pathCount} paths)`);
  });
  console.log('  schemas/');
  console.log(`    core-schemas.yaml (${Object.keys(coreSchemas).length} schemas)`);
  console.log(`    plugin-schemas.yaml (${Object.keys(pluginSchemas).length} schemas)`);
  console.log(`    common-schemas.yaml (${Object.keys(commonSchemas).length} schemas)`);
}

// Run the generator
try {
  generateOpenAPI();
} catch (error) {
  console.error('Error generating OpenAPI specification:', error);
  process.exit(1);
}
