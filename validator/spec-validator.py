#!/usr/bin/env python3
"""
Graylog OpenAPI Specification Validator

This script validates a running Graylog instance against its OpenAPI 3 specification.
It checks paths, methods, parameters, request/response schemas, and more.

Required environment variables:
- GRAYLOG_HOSTNAME: The hostname of the Graylog instance
- GRAYLOG_PORT: The port of the Graylog instance
- GRAYLOG_ACCESS_TOKEN: The access token for authentication
"""

import os
import sys
import json
import logging
import requests
import yaml
from typing import Dict, List, Any, Optional, Tuple, Set, Generator
from urllib.parse import urljoin, urlparse
from dataclasses import dataclass, field
from collections import defaultdict
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
import argparse
from jsonschema import validate, ValidationError, Draft7Validator
try:
    from jsonschema import RefResolver
except ImportError:
#    # Use the new referencing approach for jsonschema >= 4.18
#    from referencing import Registry, Resource
#    from referencing.jsonschema import DRAFT7
    print("jsonschema < 4.18 is required")
    sys.exit(1)


# Configure custom logging formatter
class EndpointFormatter(logging.Formatter):
    """Custom formatter that includes endpoint ID"""
    def __init__(self):
        super().__init__('%(asctime)s - %(endpoint_id)s - %(levelname)s - %(message)s')
        
    def format(self, record):
        # Add default endpoint_id if not present
        if not hasattr(record, 'endpoint_id'):
            record.endpoint_id = '0000'
        return super().format(record)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


@dataclass
class ValidationResult:
    """Holds validation results for a single endpoint"""
    endpoint_id: int
    path: str
    method: str
    success: bool
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    response_code: Optional[int] = None
    response_time: Optional[float] = None
    request_details: Optional[Dict[str, Any]] = None
    response_body: Optional[str] = None
    expected_response_schema: Optional[Dict[str, Any]] = None


@dataclass
class ValidationSummary:
    """Overall validation summary"""
    total_endpoints: int = 0
    tested_endpoints: int = 0
    successful_tests: int = 0
    failed_tests: int = 0
    skipped_tests: int = 0
    errors_by_type: Dict[str, int] = field(default_factory=lambda: defaultdict(int))
    results: List[ValidationResult] = field(default_factory=list)


class GraylogAPIValidator:
    """Main validator class for Graylog OpenAPI specification"""
    
    def __init__(self, spec_file: str, hostname: str, port: int, access_token: str, 
                 skip_destructive: bool = True, timeout: int = 30, max_workers: int = 5):
        """
        Initialize the validator.
        
        Args:
            spec_file: Path to the OpenAPI specification file
            hostname: Graylog hostname
            port: Graylog port
            access_token: Access token for authentication
            skip_destructive: Skip potentially destructive operations (DELETE, some POSTs)
            timeout: Request timeout in seconds
            max_workers: Maximum number of concurrent workers (1 for sequential mode)
        """
        self.spec_file = spec_file
        self.hostname = hostname
        self.port = port
        self.access_token = access_token
        self.skip_destructive = skip_destructive
        self.timeout = timeout
        self.max_workers = max_workers
        
        # Determine if we're in parallel mode
        self.parallel_mode = max_workers > 1
        
        # Build base URL
        self.base_url = f"http://{hostname}:{port}/api/"
        
        # Load OpenAPI spec
        self.spec = self._load_spec()
        
        # Session for connection pooling
        self.session = requests.Session()
        self.session.headers.update(self._get_auth_headers())
        
        # Track validation summary
        self.summary = ValidationSummary()
        
        # Cache for resolved schemas
        self.resolved_schemas = {}
        
        # Endpoint counter for IDs
        self.endpoint_counter = 0
        
        # Map of endpoint IDs to results for interactive mode
        self.results_by_id = {}
        
        # Current endpoint ID for sequential mode
        self.current_endpoint_id = 0

    def _load_spec(self) -> Dict[str, Any]:
        """Load and parse the OpenAPI specification"""
        try:
            with open(self.spec_file, 'r') as f:
                spec = yaml.safe_load(f)
            logger.info(f"Loaded OpenAPI spec: {spec.get('info', {}).get('title', 'Unknown')}")
            return spec
        except Exception as e:
            logger.error(f"Failed to load spec file: {e}")
            sys.exit(1)
            
    def _get_auth_headers(self) -> Dict[str, str]:
        """Get authentication headers based on the spec"""
        headers = {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'X-Requested-By': 'openapi-validator'  # Add CSRF header
        }
        
        # Try different authentication methods based on what the API supports
        # Most Graylog instances use session tokens or API tokens
        if self.access_token:
            # Try Basic auth with token as username
            from base64 import b64encode
            auth_string = b64encode(f"{self.access_token}:token".encode()).decode()
            headers['Authorization'] = f"Basic {auth_string}"
            
            # Also set as custom header in case it's needed
            headers['X-API-Token'] = self.access_token
            
        return headers
    
    def _resolve_ref(self, ref: str) -> Dict[str, Any]:
        """Resolve a $ref reference in the spec"""
        if ref in self.resolved_schemas:
            return self.resolved_schemas[ref]
            
        if not ref.startswith('#/'):
            logger.warning(f"External ref not supported: {ref}")
            return {}
            
        path_parts = ref[2:].split('/')
        current = self.spec
        
        for part in path_parts:
            if isinstance(current, dict) and part in current:
                current = current[part]
            else:
                logger.warning(f"Could not resolve ref: {ref}")
                return {}
                
        self.resolved_schemas[ref] = current
        return current
    
    def _build_url(self, path: str, path_params: Dict[str, Any] = None) -> str:
        """Build the full URL for a path with parameters"""
        if path_params:
            for key, value in path_params.items():
                path = path.replace(f"{{{key}}}", str(value))
        return urljoin(self.base_url, path.lstrip('/'))
    
    def _get_example_value(self, schema: Dict[str, Any], param_name: str = None) -> Any:
        """Generate an example value based on a schema"""
        if not schema:
            return None
            
        # Resolve refs
        if '$ref' in schema:
            schema = self._resolve_ref(schema['$ref'])
            
        # Check for explicit example
        if 'example' in schema:
            return schema['example']
        if 'default' in schema:
            return schema['default']
            
        # Generate based on type
        schema_type = schema.get('type', 'string')
        
        if schema_type == 'string':
            if 'enum' in schema:
                return schema['enum'][0]
            if 'format' in schema:
                fmt = schema['format']
                if fmt == 'date-time':
                    return '2024-01-01T00:00:00.000Z'
                elif fmt == 'date':
                    return '2024-01-01'
                elif fmt == 'email':
                    return 'test@example.com'
                elif fmt == 'uuid':
                    return '123e4567-e89b-12d3-a456-426614174000'
            # Special handling for common parameter names
            if param_name:
                if 'id' in param_name.lower():
                    return 'test-id'
                elif 'name' in param_name.lower():
                    return 'test-name'
                elif 'query' in param_name.lower():
                    return '*'
            return 'test-string'
            
        elif schema_type == 'integer':
            if 'enum' in schema:
                return schema['enum'][0]
            if param_name and 'page' in param_name.lower():
                return 1
            if param_name and 'size' in param_name.lower():
                return 10
            return schema.get('minimum', 1)
            
        elif schema_type == 'number':
            return schema.get('minimum', 1.0)
            
        elif schema_type == 'boolean':
            return False
            
        elif schema_type == 'array':
            items_schema = schema.get('items', {})
            item_value = self._get_example_value(items_schema)
            return [item_value] if item_value is not None else []
            
        elif schema_type == 'object':
            obj = {}
            properties = schema.get('properties', {})
            required = schema.get('required', [])
            
            for prop_name, prop_schema in properties.items():
                if prop_name in required or len(obj) < 3:  # Include required + a few optional
                    obj[prop_name] = self._get_example_value(prop_schema, prop_name)
                    
            return obj
            
        return None
    
    def _validate_response_schema(self, response_data: Any, schema: Dict[str, Any]) -> List[str]:
        """Validate response data against a schema"""
        errors = []
        
        if not schema:
            return errors


      #  # If the schema is just a $ref, resolve it first
      #  if '$ref' in schema and len(schema) == 1:
      #      ref = schema['$ref']
      #      schema = self._resolve_ref(ref)
      #      if not schema:
      #          errors.append(f"Could not resolve schema reference: {ref}")
      #          return errors
            
        try:
            resolver = RefResolver(base_uri='', referrer=self.spec)
            validator = Draft7Validator(schema, resolver=resolver)
                
            # Validate the response data
            validation_errors = list(validator.iter_errors(response_data))
            for error in validation_errors:
                errors.append(f"Schema validation error: {error.message}")
                    
        except Exception as e:
            errors.append(f"Unexpected error during schema validation: {str(e)}")
 
        return errors
    
    def _should_skip_endpoint(self, path: str, method: str, operation: Dict[str, Any]) -> bool:
        """Determine if an endpoint should be skipped"""
        # Skip if marked as deprecated
        if operation.get('deprecated', False):
            return True
            
        # Skip destructive operations if configured
        if self.skip_destructive:
            if method.upper() == 'DELETE':
                return True
            if method.upper() == 'POST' and any(x in path.lower() for x in ['delete', 'remove', 'clear', 'reset']):
                return True
            if method.upper() == 'PUT' and any(x in path.lower() for x in ['shutdown', 'restart']):
                return True
                
        # Skip certain administrative endpoints that might affect the system
        skip_patterns = [
            '/system/shutdown',
            '/system/restart',
            '/cluster/nodes/.*/shutdown',
            '/system/processing/pause',
        ]
        
        for pattern in skip_patterns:
            if re.match(pattern.replace('*', '.*'), path):
                return True
                
        return False
    
    def _validate_endpoint(self, endpoint_id: int, path: str, method: str, operation: Dict[str, Any]) -> ValidationResult:
        """Validate a single endpoint"""
        result = ValidationResult(endpoint_id=endpoint_id, path=path, method=method.upper(), success=False)
        
        # Check if we should skip this endpoint
        if self._should_skip_endpoint(path, method, operation):
            result.warnings.append("Skipped: Potentially destructive or deprecated endpoint")
            return result
            
        try:
            # Build request parameters
            params = {}
            path_params = {}
            headers = dict(self.session.headers)
            json_body = None
            
            # Process parameters
            for param in operation.get('parameters', []):
                param_name = param.get('name')
                param_in = param.get('in')
                param_required = param.get('required', False)
                param_schema = param.get('schema', {})
                
                # Skip if not required and we're doing minimal testing
                if not param_required and method.upper() == 'GET':
                    continue
                    
                # Generate example value
                example_value = self._get_example_value(param_schema, param_name)
                
                if example_value is not None:
                    if param_in == 'query':
                        params[param_name] = example_value
                    elif param_in == 'path':
                        path_params[param_name] = example_value
                    elif param_in == 'header':
                        headers[param_name] = str(example_value)
                elif param_required:
                    result.errors.append(f"Could not generate required parameter: {param_name}")
                    
            # Process request body
            request_body = operation.get('requestBody', {})
            if request_body:
                content = request_body.get('content', {})
                if 'application/json' in content:
                    body_schema = content['application/json'].get('schema', {})
                    json_body = self._get_example_value(body_schema)
                    
                    if json_body is None and request_body.get('required', False):
                        result.errors.append("Could not generate required request body")
                        
            # Build URL
            url = self._build_url(path, path_params)
            
            # Store request details
            result.request_details = {
                'method': method.upper(),
                'url': url,
                'headers': headers,
                'params': params,
                'body': json_body
            }
            
            # Make request
            start_time = time.time()
            
            request_kwargs = {
                'timeout': self.timeout,
                'headers': headers,
                'params': params if params else None,
                'json': json_body if json_body is not None else None
            }
            
            # Remove None values
            request_kwargs = {k: v for k, v in request_kwargs.items() if v is not None}
            
            response = self.session.request(method, url, **request_kwargs)
            
            result.response_time = time.time() - start_time
            result.response_code = response.status_code
            result.response_body = response.text
            
            # Validate response
            responses = operation.get('responses', {})
            
            # Check if response code is expected
            expected_codes = list(responses.keys())
            status_code_str = str(response.status_code)
            
            if status_code_str not in expected_codes:
                # Check for wildcards like 2XX
                wildcard_match = False
                for code in expected_codes:
                    if 'XX' in code:
                        pattern = code.replace('XX', '..')
                        if re.match(pattern, status_code_str):
                            wildcard_match = True
                            status_code_str = code
                            break
                            
                if not wildcard_match:
                    result.errors.append(f"Unexpected response code: {response.status_code}. Expected: {expected_codes}")
                    
            # Validate response schema if successful
            if response.status_code < 400 and status_code_str in responses:
                response_spec = responses[status_code_str]
                content = response_spec.get('content', {})
                
                if 'application/json' in content and response.text:
                    try:
                        response_data = response.json()
                        schema = content['application/json'].get('schema', {})
                        result.expected_response_schema = schema
                        schema_errors = self._validate_response_schema(response_data, schema)
                        result.errors.extend(schema_errors)
                    except json.JSONDecodeError:
                        result.errors.append("Response is not valid JSON")
                        
            # Check for rate limiting
            if response.status_code == 429:
                result.warnings.append("Rate limited - consider reducing concurrent requests")
                
            # Mark as successful if no errors
            if not result.errors:
                result.success = True
                
        except requests.exceptions.Timeout:
            result.errors.append(f"Request timeout after {self.timeout} seconds")
        except requests.exceptions.ConnectionError as e:
            result.errors.append(f"Connection error: {str(e)}")
        except Exception as e:
            result.errors.append(f"Unexpected error: {str(e)}")
            
        return result
    
    def validate_sequential(self, start_from: int = 1) -> Generator[ValidationResult, None, None]:
        """
        Generator that validates endpoints sequentially, one at a time.
        
        Args:
            start_from: Endpoint ID to start validation from (1-based)
            
        Yields:
            ValidationResult for each endpoint
        """
        paths = self.spec.get('paths', {})
        
        # Collect all endpoints with IDs
        endpoints = []
        endpoint_id = 0
        
        for path, path_item in paths.items():
            for method, operation in path_item.items():
                if method in ['get', 'post', 'put', 'delete', 'patch']:
                    endpoint_id += 1
                    endpoints.append((endpoint_id, path, method, operation))
        
        self.summary.total_endpoints = len(endpoints)
        
        # Start from the specified endpoint
        for endpoint_id, path, method, operation in endpoints:
            if endpoint_id < start_from:
                continue
                
            # Store current position for resume capability
            self.current_endpoint_id = endpoint_id
            
            logger.info(f"Validating endpoint {endpoint_id}/{len(endpoints)}: {method.upper()} {path}")
            
            # Validate the endpoint
            result = self._validate_endpoint(endpoint_id, path, method, operation)
            
            # Update summary
            self.summary.tested_endpoints += 1
            self._update_summary(result)
            
            # Store result for interactive mode
            self.results_by_id[endpoint_id] = result
            self.summary.results.append(result)
            
            # Yield the result
            yield result
    
    def validate_all(self, parallel: bool = True, start_from: int = 1) -> ValidationSummary:
        """
        Validate all endpoints in the specification.
        
        Args:
            parallel: Whether to run validation in parallel
            start_from: For sequential mode, which endpoint to start from
            
        Returns:
            ValidationSummary with all results
        """
        if not parallel or self.max_workers == 1:
            # Sequential validation using the generator
            logger.info("Running sequential validation...")
            
            for result in self.validate_sequential(start_from):
                # Results are already processed in the generator
                pass
                
        else:
            # Parallel validation (existing code)
            logger.info(f"Running parallel validation with {self.max_workers} workers...")
            
            paths = self.spec.get('paths', {})
            
            # Collect all endpoints with IDs
            endpoints = []
            for path, path_item in paths.items():
                for method, operation in path_item.items():
                    if method in ['get', 'post', 'put', 'delete', 'patch']:
                        self.endpoint_counter += 1
                        endpoints.append((self.endpoint_counter, path, method, operation))
            
            self.summary.total_endpoints = len(endpoints)
            
            # Validate in parallel
            with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
                # Submit all validation tasks
                future_to_endpoint = {
                    executor.submit(self._validate_endpoint, eid, path, method, op): (eid, path, method)
                    for eid, path, method, op in endpoints
                    if eid >= start_from  # Respect start_from even in parallel mode
                }
                
                # Process results as they complete
                for future in as_completed(future_to_endpoint):
                    endpoint_id, path, method = future_to_endpoint[future]
                    try:
                        result = future.result()
                        self.summary.tested_endpoints += 1
                        self._update_summary(result)
                        self.results_by_id[endpoint_id] = result
                        self.summary.results.append(result)
                    except Exception as e:
                        logger.error(f"Failed to validate {method} {path}: {e}")
                        
        return self.summary


    def _process_result(self, result: ValidationResult):
        """Process and record a validation result"""
        self.summary.results.append(result)
        self.summary.tested_endpoints += 1
        
        # Store result by ID for interactive mode
        self.results_by_id[result.endpoint_id] = result
        
        # Create a custom log record with endpoint_id
        if result.success:
            self.summary.successful_tests += 1
            msg = f"✓ {result.method} {result.path} - {result.response_code} ({result.response_time:.2f}s)"
            logger.info(msg, extra={'endpoint_id': f'{result.endpoint_id:04d}'})
        elif result.warnings and not result.errors:
            self.summary.skipped_tests += 1
            msg = f"⊘ {result.method} {result.path} - {result.warnings[0]}"
            logger.warning(msg, extra={'endpoint_id': f'{result.endpoint_id:04d}'})
        else:
            self.summary.failed_tests += 1
            msg = f"✗ {result.method} {result.path} - {result.errors[0] if result.errors else 'Unknown error'}"
            logger.error(msg, extra={'endpoint_id': f'{result.endpoint_id:04d}'})
            
            # Categorize errors
            for error in result.errors:
                if 'Schema validation' in error:
                    self.summary.errors_by_type['schema_validation'] += 1
                elif 'response code' in error:
                    self.summary.errors_by_type['unexpected_response'] += 1
                elif 'Connection error' in error:
                    self.summary.errors_by_type['connection_error'] += 1
                elif 'timeout' in error.lower():
                    self.summary.errors_by_type['timeout'] += 1
                else:
                    self.summary.errors_by_type['other'] += 1
                    
    def print_summary(self):
        """Print a summary of the validation results"""
        print("\n" + "="*60)
        print("VALIDATION SUMMARY")
        print("="*60)
        print(f"Total endpoints in spec:  {self.summary.total_endpoints}")
        print(f"Endpoints tested:         {self.summary.tested_endpoints}")
        print(f"Successful tests:         {self.summary.successful_tests}")
        print(f"Failed tests:             {self.summary.failed_tests}")
        print(f"Skipped tests:            {self.summary.skipped_tests}")
        
        if self.summary.errors_by_type:
            print("\nError breakdown:")
            for error_type, count in self.summary.errors_by_type.items():
                print(f"  {error_type}: {count}")
                
        # Show failed endpoints
        failed = [r for r in self.summary.results if not r.success and r.errors]
        if failed:
            print(f"\nFailed endpoints (showing first 10):")
            for result in failed[:10]:
                print(f"  - {result.method} {result.path}")
                for error in result.errors[:2]:  # Show first 2 errors
                    print(f"    → {error}")
                    
    def export_results(self, output_file: str):
        """Export detailed results to a JSON file"""
        results_data = {
            'summary': {
                'total_endpoints': self.summary.total_endpoints,
                'tested_endpoints': self.summary.tested_endpoints,
                'successful_tests': self.summary.successful_tests,
                'failed_tests': self.summary.failed_tests,
                'skipped_tests': self.summary.skipped_tests,
                'errors_by_type': dict(self.summary.errors_by_type)
            },
            'results': [
                {
                    'endpoint_id': r.endpoint_id,
                    'path': r.path,
                    'method': r.method,
                    'success': r.success,
                    'response_code': r.response_code,
                    'response_time': r.response_time,
                    'errors': r.errors,
                    'warnings': r.warnings
                }
                for r in self.summary.results
            ]
        }
        
        with open(output_file, 'w') as f:
            json.dump(results_data, f, indent=2)
            
        logger.info(f"Detailed results exported to {output_file}")
    
   
    def interactive_mode(self):
        """Interactive mode to inspect individual endpoint results"""
        if not self.results_by_id:
            print("No validation results available. Run validation first.")
            return
            
        print("\n" + "="*60)
        print("INTERACTIVE MODE")
        print("="*60)
        print("Commands:")
        print("  list [n] - List n endpoints (default: 10)")
        print("  show <id> - Show detailed result for endpoint ID")
        print("  failed - List all failed endpoints")
        print("  export <file> - Export results to JSON file")
        
        # Add 'next' command only if in sequential mode
        if hasattr(self, 'current_endpoint_id') and not self.parallel_mode:
            print("  next - Validate the next endpoint (sequential mode only)")
            
        print("  quit - Exit interactive mode")
        print()
        
        while True:
            try:
                command = input("validator> ").strip().lower()
                
                if command == 'quit' or command == 'q':
                    break
                    
                elif command.startswith('list'):
                    parts = command.split()
                    n = int(parts[1]) if len(parts) > 1 else 10
                    self._list_endpoints(n)
                    
                elif command.startswith('show'):
                    parts = command.split()
                    if len(parts) > 1:
                        try:
                            endpoint_id = int(parts[1])
                            self._show_endpoint_detail(endpoint_id)
                        except ValueError:
                            print(f"Invalid endpoint ID: {parts[1]}")
                    else:
                        print("Usage: show <endpoint_id>")
                        
                elif command == 'failed':
                    self._list_failed_endpoints()
                    
                elif command.startswith('export'):
                    parts = command.split()
                    if len(parts) > 1:
                        self.export_results(parts[1])
                    else:
                        print("Usage: export <filename>")
                        
                elif command == 'next':
                    # Handle 'next' command for sequential validation
                    if not hasattr(self, 'current_endpoint_id'):
                        print("Error: 'next' command is only available in sequential mode (use --sequential flag)")
                    elif self.parallel_mode:
                        print("Error: 'next' command is not available when running in parallel mode")
                    else:
                        # Validate the next endpoint
                        next_id = getattr(self, 'current_endpoint_id', 0) + 1
                        
                        # Check if there are more endpoints
                        if next_id > self.summary.total_endpoints:
                            print(f"No more endpoints to validate. Reached end ({self.summary.total_endpoints} endpoints).")
                        else:
                            print(f"\nValidating next endpoint (#{next_id})...")
                            
                            # Use the generator to get the next result
                            try:
                                for result in self.validate_sequential(start_from=next_id):
                                    # Just process one endpoint
                                    print(f"\nValidated: {result.method} {result.path}")
                                    if result.success:
                                        print(f"✓ Success - {result.response_code}")
                                    elif result.warnings and not result.errors:
                                        print(f"⊘ Skipped - {result.warnings[0]}")
                                    else:
                                        print(f"✗ Failed - {result.errors[0] if result.errors else 'Unknown error'}")
                                        if len(result.errors) > 1:
                                            print(f"  (+{len(result.errors)-1} more errors)")
                                    
                                    # Ask if user wants to see details
                                    if input("\nShow details? (y/n): ").lower() == 'y':
                                        self._show_endpoint_detail(next_id)
                                        
                                    break  # Only process one endpoint
                                    
                            except Exception as e:
                                print(f"Error validating endpoint: {e}")
                                
                else:
                    print(f"Unknown command: {command}")
                    print("Type 'help' for available commands")
                    
            except KeyboardInterrupt:
                print("\nExiting interactive mode...")
                break
            except Exception as e:
                print(f"Error: {e}")
 
    def _display_endpoint_definition(self, endpoint_id: int):
        """Display the OpenAPI specification definition for an endpoint"""
        result = self.results_by_id[endpoint_id]
        
        print("\n" + "="*60)
        print(f"ENDPOINT {endpoint_id:04d} DEFINITION")
        print("="*60)
        
        print(f"\nEndpoint: {result.method} {result.path}")
        
        # Find the operation definition in the spec
        if result.path in self.spec.get('paths', {}):
            path_item = self.spec['paths'][result.path]
            if result.method.lower() in path_item:
                operation = path_item[result.method.lower()]
                
                print("\n--- ENDPOINT DEFINITION ---")
                
                # Format as YAML-like output
                print(f"  {result.path}:")
                print(f"    {result.method.lower()}:")
                
                # Summary
                if 'summary' in operation:
                    print(f"      summary: {operation['summary']}")
                
                # Operation ID
                if 'operationId' in operation:
                    print(f"      operationId: {operation['operationId']}")
                
                # Tags
                if 'tags' in operation:
                    print(f"      tags:")
                    for tag in operation['tags']:
                        print(f"        - {tag}")
                
                # Description
                if 'description' in operation:
                    desc = operation['description']
                    if len(desc) > 100:
                        desc = desc[:100] + "..."
                    print(f"      description: {desc}")
                
                # Parameters
                if 'parameters' in operation:
                    print(f"      parameters:")
                    for param in operation['parameters']:
                        print(f"        - name: {param.get('name', 'unknown')}")
                        print(f"          in: {param.get('in', 'unknown')}")
                        print(f"          required: {param.get('required', False)}")
                        if 'description' in param:
                            desc = param['description']
                            if len(desc) > 50:
                                desc = desc[:50] + "..."
                            print(f"          description: {desc}")
                
                # Request body
                if 'requestBody' in operation:
                    rb = operation['requestBody']
                    print(f"      requestBody:")
                    print(f"        required: {rb.get('required', False)}")
                    if 'description' in rb:
                        print(f"        description: {rb['description']}")
                    if 'content' in rb:
                        print(f"        content:")
                        for content_type in rb['content']:
                            print(f"          {content_type}:")
                            if 'schema' in rb['content'][content_type]:
                                schema = rb['content'][content_type]['schema']
                                if '$ref' in schema:
                                    print(f"            schema:")
                                    print(f"              $ref: '{schema['$ref']}'")
                                elif 'type' in schema:
                                    print(f"            schema:")
                                    print(f"              type: {schema['type']}")
                
                # Responses
                if 'responses' in operation:
                    print(f"      responses:")
                    for code, response in operation['responses'].items():
                        print(f"        '{code}':")
                        if 'description' in response:
                            print(f"          description: {response['description']}")
                        if 'content' in response:
                            print(f"          content:")
                            for content_type in response['content']:
                                print(f"            {content_type}:")
                                if 'schema' in response['content'][content_type]:
                                    schema = response['content'][content_type]['schema']
                                    if '$ref' in schema:
                                        print(f"              schema:")
                                        print(f"                $ref: '{schema['$ref']}'")
                                    elif 'type' in schema:
                                        print(f"              schema:")
                                        print(f"                type: {schema['type']}")
            else:
                print(f"\nMethod {result.method.lower()} not found in spec for path {result.path}")
        else:
            print(f"\nPath {result.path} not found in specification")
        
        print("\n" + "="*60)
    
    def _display_endpoint_details(self, endpoint_id: int):
        """Display detailed information about a specific endpoint test"""
        result = self.results_by_id[endpoint_id]
        
        print("\n" + "="*60)
        print(f"ENDPOINT {endpoint_id:04d} DETAILS")
        print("="*60)
        
        # Basic info
        print(f"\nEndpoint: {result.method} {result.path}")
        print(f"Status: {'SUCCESS' if result.success else 'FAILED' if result.errors else 'SKIPPED'}")
        if result.response_code:
            print(f"Response Code: {result.response_code}")
        if result.response_time:
            print(f"Response Time: {result.response_time:.3f} seconds")
        
        # Log line (reconstruct what would have been logged)
        if result.success:
            log_line = f"INFO - ✓ {result.method} {result.path} - {result.response_code} ({result.response_time:.2f}s)"
        elif result.warnings and not result.errors:
            log_line = f"WARNING - ⊘ {result.method} {result.path} - {result.warnings[0]}"
        else:
            log_line = f"ERROR - ✗ {result.method} {result.path} - {result.errors[0] if result.errors else 'Unknown error'} (+{len(result.errors)-1 if len(result.errors) > 0 else 0} more errors)"
        print(f"\nLog Line: {log_line}")
        
        # Errors and warnings
        if result.errors:
            print(f"\nErrors ({len(result.errors)}):")
            for i, error in enumerate(result.errors, 1):
                print(f"  {i}. {error}")
                
        if result.warnings:
            print(f"\nWarnings ({len(result.warnings)}):")
            for i, warning in enumerate(result.warnings, 1):
                print(f"  {i}. {warning}")
        
        # Request details
        if result.request_details:
            print("\n--- REQUEST ---")
            print(f"Method: {result.request_details['method']}")
            print(f"URL: {result.request_details['url']}")
            
            if result.request_details.get('params'):
                print(f"Query Parameters: {json.dumps(result.request_details['params'], indent=2)}")
                
            if result.request_details.get('body'):
                print(f"Request Body:")
                print(json.dumps(result.request_details['body'], indent=2))
                
            # Show relevant headers (exclude auth for security)
            headers = result.request_details.get('headers', {})
            safe_headers = {k: v for k, v in headers.items() 
                           if not any(auth in k.lower() for auth in ['auth', 'token', 'key', 'secret'])}
            if safe_headers:
                print(f"Headers (excluding auth): {json.dumps(safe_headers, indent=2)}")
        
        # Expected response schema
        if result.expected_response_schema:
            print("\n--- EXPECTED RESPONSE SCHEMA ---")
            # Simplify schema display
            schema_str = json.dumps(result.expected_response_schema, indent=2)
            if len(schema_str) > 1000:
                schema_str = schema_str[:1000] + "\n... (truncated)"
            print(schema_str)
        
        # Actual response
        if result.response_body:
            print("\n--- ACTUAL RESPONSE ---")
            try:
                # Try to parse and pretty-print JSON
                response_json = json.loads(result.response_body)
                response_str = json.dumps(response_json, indent=2)
            except json.JSONDecodeError:
                # Not JSON, display as-is
                response_str = result.response_body
                
            # Truncate very long responses
            if len(response_str) > 2000:
                response_str = response_str[:2000] + "\n... (truncated - full response: {} bytes)".format(len(result.response_body))
            print(response_str)
        
        print("\n" + "="*60)


def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(description='Validate Graylog API against OpenAPI specification')
    parser.add_argument('spec_file', help='Path to OpenAPI specification file')
    parser.add_argument('--allow-destructive', action='store_true', default=False,
                       help='Allow the script to perform potentially destructive operations (default: False)')
    parser.add_argument('--timeout', type=int, default=30,
                       help='Request timeout in seconds (default: 30)')
    parser.add_argument('--max-workers', type=int, default=5,
                       help='Maximum concurrent workers, use 1 for sequential mode (default: 5)')
    parser.add_argument('--sequential', action='store_true',
                       help='Force sequential mode (equivalent to --max-workers=1)')
    parser.add_argument('--start-from', type=int, default=1,
                       help='Start validation from endpoint ID (1-based, default: 1, works with sequential mode)')
    parser.add_argument('--export', help='Export detailed results to JSON file')
    parser.add_argument('--verbose', action='store_true',
                       help='Enable verbose logging')
    parser.add_argument('--divein', action='store_true',
                       help='Enter interactive mode after validation to inspect individual results')
    
    args = parser.parse_args()
    
    # Setup custom logging with endpoint IDs
    handler = logging.StreamHandler()
    handler.setFormatter(EndpointFormatter())
    logger.handlers.clear()
    logger.addHandler(handler)
    
    # Set logging level
    if args.verbose:
        logger.setLevel(logging.DEBUG)
    else:
        logger.setLevel(logging.INFO)
    
    # Get environment variables
    hostname = os.environ.get('GRAYLOG_HOSTNAME')
    port = os.environ.get('GRAYLOG_PORT')
    access_token = os.environ.get('GRAYLOG_ACCESS_TOKEN')
    
    if not all([hostname, port, access_token]):
        logger.error("Missing required environment variables: GRAYLOG_HOSTNAME, GRAYLOG_PORT, GRAYLOG_ACCESS_TOKEN")
        sys.exit(1)
        
    try:
        port = int(port)
    except ValueError:
        logger.error(f"Invalid port number: {port}")
        sys.exit(1)
    
    # Handle sequential mode flag
    max_workers = args.max_workers
    if args.sequential:
        max_workers = 1
        logger.info("Sequential mode enabled (--sequential flag set)")
    
    # Validate start_from value
    if args.start_from < 1:
        logger.error(f"Invalid start-from value: {args.start_from}. Must be >= 1")
        sys.exit(1)
    
    # Create validator
    validator = GraylogAPIValidator(
        spec_file=args.spec_file,
        hostname=hostname,
        port=port,
        access_token=access_token,
        skip_destructive=not args.allow_destructive,
        timeout=args.timeout,
        max_workers=max_workers
    )
    
    # Run validation
    logger.info(f"Starting validation against {hostname}:{port}")
    
    if max_workers == 1:
        logger.info(f"Settings: timeout={args.timeout}s, mode=sequential, skip_destructive={not args.allow_destructive}")
        if args.start_from > 1:
            logger.info(f"Starting from endpoint #{args.start_from}")
    else:
        logger.info(f"Settings: timeout={args.timeout}s, max_workers={max_workers}, mode=parallel, skip_destructive={not args.allow_destructive}")
        if args.start_from > 1:
            logger.warning(f"Note: --start-from is most useful with sequential mode")
    
    # Run validation with appropriate mode
    parallel = max_workers > 1
    summary = validator.validate_all(parallel=parallel, start_from=args.start_from)
    
    # Print summary
    validator.print_summary()
    
    # Export results if requested
    if args.export:
        validator.export_results(args.export)
    
    # Enter interactive mode if requested
    if args.divein:
        validator.interactive_mode()
    
    # Exit with appropriate code
    if summary.failed_tests > 0:
        sys.exit(1)
    else:
        sys.exit(0)


if __name__ == '__main__':
    main()
