/**
 * Tool registration helpers.
 *
 * **Why this module exists instead of `defineTool` from `@deepseek-ai/dsh-tools`.**
 * `defineTool` is a thin compiler: it turns the schema DSL into a JSON Schema and
 * wraps `execute` with argument validation. The registry consumes the compiled
 * object, so the same descriptor can be built here without the import.
 *
 * That matters for two concrete reasons, both discovered rather than assumed:
 *
 *  1. **Resolution.** This package is installed into a profile as a *symlink*
 *     (`dsh plugin add <dir>` uses `link:`), so a bare `@deepseek-ai/*` specifier
 *     resolves by walking up from this package's **real** path — the developer's
 *     checkout — and never reaches `~/.dsh/profiles/node_modules`, where the
 *     peers actually live. A top-level peer import would fail to resolve.
 *  2. **Version skew.** The registry's `@deepseek-ai/dsh-tools` is `0.0.1-rc.1`
 *     while the installed host is `0.1.7-rc.2`. Installing the registry copy
 *     would put a second, mismatched copy in the tree rather than using the
 *     host's.
 *
 * The shapes below are transcribed from the installed
 * `@deepseek-ai/dsh-tools/lib/index.js` (`defineTool`, `function defineTool`),
 * so the registry sees exactly what it would have seen.
 *
 * @module dsho/host/tool
 */

/** A JSON Schema property descriptor, as the registry stores it. */
export interface JsonSchemaProperty {
  type: string
  description?: string
  enum?: readonly string[]
  items?: JsonSchemaProperty
  /** Nested properties, for an `object`-typed parameter. */
  properties?: Readonly<Record<string, JsonSchemaProperty>>
  required?: readonly string[]
}

/** The JSON Schema the registry stores for a tool's parameters. */
export interface JsonSchema {
  type: 'object'
  properties: Record<string, JsonSchemaProperty>
  required: string[]
  additionalProperties: false
}

/** One entry in the schema DSL this module compiles. */
export interface ParameterSpec {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object'
  required?: boolean
  description?: string
  enum?: readonly string[]
  items?: ParameterSpec
  properties?: Readonly<Record<string, ParameterSpec>>
}

/** Content blocks a tool returns. The registry appends these to the log. */
export interface ToolTextContent {
  type: 'text'
  text: string
}

/** What `execute` receives. */
export interface ToolExecution {
  /** Aborts when the caller cancels. Async bodies must observe it. */
  signal?: AbortSignal
}

/** The compiled tool object the registry accepts. */
export interface ToolDescriptor<A = Record<string, unknown>, R = unknown> {
  name: string
  description: string
  parameters: JsonSchema
  output: {
    schema: { type: string }
    render: (args: A, value: R) => ToolTextContent[]
  }
  execute: (args: A, exec: ToolExecution) => Promise<R> | R
  timeoutMs?: number
}

function compileProperty(spec: ParameterSpec): JsonSchemaProperty {
  const out: JsonSchemaProperty = { type: spec.type }
  if (spec.description !== undefined) out.description = spec.description
  if (spec.enum !== undefined) out.enum = spec.enum
  if (spec.items !== undefined) out.items = compileProperty(spec.items)
  if (spec.properties !== undefined) {
    const nested: Record<string, JsonSchemaProperty> = {}
    for (const [key, child] of Object.entries(spec.properties)) nested[key] = compileProperty(child)
    out.properties = nested
    out.required = Object.entries(spec.properties)
      .filter(([, child]) => child.required === true)
      .map(([key]) => key)
  }
  return out
}

/**
 * Compiles the schema DSL into the JSON Schema the tool registry stores.
 *
 * Exported because the parameter shapes are worth asserting in a test: a tool
 * whose schema is wrong is rejected by the model, not by a type checker.
 */
export function compileParameters(
  parameters: Readonly<Record<string, ParameterSpec>>,
): JsonSchema {
  const properties: Record<string, JsonSchemaProperty> = {}
  const required: string[] = []
  for (const [key, spec] of Object.entries(parameters)) {
    properties[key] = compileProperty(spec)
    if (spec.required === true) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/**
 * Builds one tool descriptor.
 *
 * Deliberately a near-copy of `defineTool`'s output shape, minus the schema-DSL
 * sugar this plugin does not need. Every tool renders a single text block, which
 * is what the registry expects from `output.render`.
 */
export function defineTool<A extends Record<string, unknown>, R>(options: {
  name: string
  description: string
  parameters: Readonly<Record<string, ParameterSpec>>
  /** The JSON type of the tool's return value, for the registry's record. */
  outputType?: string
  /** Renders the value the model reads. Defaults to `JSON.stringify(…, 2)`. */
  render?: (args: A, value: R) => string
  execute: (args: A, exec: ToolExecution) => Promise<R> | R
  timeoutMs?: number
}): ToolDescriptor<A, R> {
  const render = options.render ?? ((_args: A, value: R) => JSON.stringify(value, null, 2))
  const descriptor: ToolDescriptor<A, R> = {
    name: options.name,
    description: options.description,
    parameters: compileParameters(options.parameters),
    output: {
      schema: { type: options.outputType ?? 'string' },
      render: (args, value) => [{ type: 'text', text: render(args, value) }],
    },
    execute: options.execute,
  }
  if (options.timeoutMs !== undefined) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`)
    }
    descriptor.timeoutMs = options.timeoutMs
  }
  return descriptor
}
