#!/usr/bin/env node

/**
 * Combine modular OpenAPI YAML files into a single file
 * 
 * Usage:
 *   node combine-openapi.js [output-file]
 * 
 * Default output: graylog-openapi-combined.yaml
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// Configuration
const SOURCE_DIR = './graylog-api';
const DEFAULT_OUTPUT = 'graylog-openapi-combined.yaml';

// Parse command line arguments
const outputFile = process.argv[2] || DEFAULT_OUTPUT;

/**
 * Recursively resolve $ref references in an object
 */
function resolveRefs(obj, basePath, loadedFiles = new Set()) {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => resolveRefs(item, basePath, loadedFiles));
  }
  
  const result = {};
  
  for (const [key, value] of Object.entries(obj)) {
    if (key === '$ref' && typeof value === 'string') {
      // Handle external file reference
      if (value.startsWith('./')) {
        const [filePath, fragment] = value.split('#');
        const fullPath = path.resolve(basePath, filePath);
        
        // Avoid circular references
        if (loadedFiles.has(fullPath)) {
          console.warn(`Circular reference detected: ${fullPath}`);
          continue;
        }
        
        loadedFiles.add(fullPath);
        
        try {
          const fileContent = fs.readFileSync(fullPath, 'utf8');
          const parsedContent = yaml.load(fileContent);
          
          // Navigate to the fragment if specified
          let referencedContent = parsedContent;
          if (fragment) {
            const pathParts = fragment.split('/').filter(p => p);
            for (const part of pathParts) {
              referencedContent = referencedContent[part];
              if (!referencedContent) {
                console.warn(`Fragment not found: ${fragment} in ${filePath}`);
                break;
              }
            }
          }
          
          // Recursively resolve refs in the loaded content
          return resolveRefs(referencedContent, path.dirname(fullPath), loadedFiles);
        } catch (error) {
          console.error(`Error loading reference ${value}:`, error.message);
        }
      } else {
        // Keep internal references as-is
        result[key] = value;
      }
    } else {
      result[key] = resolveRefs(value, basePath, loadedFiles);
    }
  }
  
  return result;
}

/**
 * Merge paths from multiple sources
 */
function mergePaths(mainPaths, pathFiles) {
  const mergedPaths = {};
  
  pathFiles.forEach(file => {
    const filePath = path.join(SOURCE_DIR, 'paths', file);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = yaml.load(content);
        
        if (parsed && parsed.paths) {
          Object.assign(mergedPaths, parsed.paths);
        }
      } catch (error) {
        console.error(`Error loading ${file}:`, error.message);
      }
    }
  });
  
  return mergedPaths;
}

/**
 * Merge schemas from multiple sources
 */
function mergeSchemas(schemaFiles) {
  const mergedSchemas = {};
  
  schemaFiles.forEach(file => {
    const filePath = path.join(SOURCE_DIR, 'schemas', file);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = yaml.load(content);
        
        if (parsed && parsed.components && parsed.components.schemas) {
          Object.assign(mergedSchemas, parsed.components.schemas);
        }
      } catch (error) {
        console.error(`Error loading ${file}:`, error.message);
      }
    }
  });
  
  return mergedSchemas;
}

/**
 * Main function to combine OpenAPI files
 */
function combineOpenAPI() {
  console.log('Loading main OpenAPI file...');
  const mainFilePath = path.join(SOURCE_DIR, 'openapi.yaml');
  
  if (!fs.existsSync(mainFilePath)) {
    console.error(`Main file not found: ${mainFilePath}`);
    console.error('Please run generate-openapi.js first to create the modular files.');
    process.exit(1);
  }
  
  const mainContent = fs.readFileSync(mainFilePath, 'utf8');
  const mainSpec = yaml.load(mainContent);
  
  // Get list of path files
  const pathsDir = path.join(SOURCE_DIR, 'paths');
  const pathFiles = fs.existsSync(pathsDir) 
    ? fs.readdirSync(pathsDir).filter(f => f.endsWith('.yaml'))
    : [];
  
  console.log(`Found ${pathFiles.length} path files`);
  
  // Get list of schema files
  const schemasDir = path.join(SOURCE_DIR, 'schemas');
  const schemaFiles = fs.existsSync(schemasDir)
    ? fs.readdirSync(schemasDir).filter(f => f.endsWith('.yaml'))
    : [];
  
  console.log(`Found ${schemaFiles.length} schema files`);
  
  // Merge all paths
  console.log('Merging paths...');
  const mergedPaths = mergePaths(mainSpec.paths || {}, pathFiles);
  
  // Merge all schemas
  console.log('Merging schemas...');
  const mergedSchemas = mergeSchemas(schemaFiles);
  
  // Build combined spec
  const combinedSpec = {
    ...mainSpec,
    paths: mergedPaths,
    components: {
      ...mainSpec.components,
      schemas: mergedSchemas
    }
  };
  
  // Remove any remaining $ref to external files in paths
  delete combinedSpec.paths['$ref'];
  
  // Count statistics
  const pathCount = Object.keys(mergedPaths).length;
  const operationCount = Object.values(mergedPaths).reduce((acc, path) => {
    return acc + Object.keys(path).filter(key => ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'].includes(key)).length;
  }, 0);
  const schemaCount = Object.keys(mergedSchemas).length;
  
  // Write combined file
  console.log(`Writing combined file to ${outputFile}...`);
  const yamlContent = yaml.dump(combinedSpec, {
    lineWidth: -1,
    noRefs: false,
    sortKeys: false
  });
  
  fs.writeFileSync(outputFile, yamlContent);
  
  // Summary
  console.log('\n=== Combination Complete ===');
  console.log(`Output file: ${outputFile}`);
  console.log(`File size: ${(fs.statSync(outputFile).size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Total paths: ${pathCount}`);
  console.log(`Total operations: ${operationCount}`);
  console.log(`Total schemas: ${schemaCount}`);
  
  // Validate the combined spec
  console.log('\nValidating combined specification...');
  try {
    // Basic validation - check for required fields
    if (!combinedSpec.openapi) {
      console.error('❌ Missing openapi version');
    } else {
      console.log('✓ OpenAPI version:', combinedSpec.openapi);
    }
    
    if (!combinedSpec.info || !combinedSpec.info.title || !combinedSpec.info.version) {
      console.error('❌ Missing or incomplete info section');
    } else {
      console.log('✓ API info present');
    }
    
    if (!combinedSpec.paths || Object.keys(combinedSpec.paths).length === 0) {
      console.error('❌ No paths defined');
    } else {
      console.log('✓ Paths defined:', Object.keys(combinedSpec.paths).length);
    }
    
    // Check for broken internal references
    const schemaRefs = JSON.stringify(combinedSpec).match(/#\/components\/schemas\/([^"'}\s]+)/g) || [];
    const uniqueRefs = [...new Set(schemaRefs.map(ref => ref.split('/').pop()))];
    const missingSchemas = uniqueRefs.filter(ref => !mergedSchemas[ref]);
    
    if (missingSchemas.length > 0) {
      console.warn(`⚠ Missing schema definitions: ${missingSchemas.slice(0, 10).join(', ')}${missingSchemas.length > 10 ? '...' : ''}`);
    } else {
      console.log('✓ All schema references resolved');
    }
    
  } catch (error) {
    console.error('Error during validation:', error.message);
  }
}

// Run the combiner
try {
  combineOpenAPI();
} catch (error) {
  console.error('Error combining OpenAPI specification:', error);
  process.exit(1);
}
