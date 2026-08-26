import type { Diagnostic, FieldPresentation, JsonSchema, PresentationSpec } from '../../api/types';

export interface ResolvedField {
  readonly key: string;
  readonly schema: JsonSchema;
  readonly presentation: FieldPresentation;
  readonly required: boolean;
}

function decodePointerPart(part: string): string {
  return part.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function resolveSchema(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (!schema.$ref?.startsWith('#/')) return schema;
  let current: unknown = root;
  for (const part of schema.$ref.slice(2).split('/').map(decodePointerPart)) {
    if (typeof current !== 'object' || current === null || !(part in current)) return schema;
    current = (current as Record<string, unknown>)[part];
  }
  if (typeof current !== 'object' || current === null || Array.isArray(current)) return schema;
  return { ...(current as JsonSchema), ...schema, $ref: undefined };
}

export function schemaAlternatives(schema: JsonSchema): readonly JsonSchema[] {
  return schema.oneOf ?? schema.anyOf ?? [];
}

export function schemaType(schema: JsonSchema, root: JsonSchema): string {
  const resolved = resolveSchema(schema, root);
  if (typeof resolved.type === 'string') return resolved.type;
  if (Array.isArray(resolved.type)) return resolved.type.find((item) => item !== 'null') ?? 'string';
  if (resolved.properties) return 'object';
  if (resolved.items) return 'array';
  if (resolved.enum || resolved.const !== undefined) return typeof (resolved.enum?.[0] ?? resolved.const);
  const alternatives = schemaAlternatives(resolved);
  if (alternatives.length > 0) {
    return schemaType(alternatives.find((item) => item.const !== null) ?? alternatives[0] ?? {}, root);
  }
  return 'string';
}

export function schemaSemantic(schema: JsonSchema, root: JsonSchema = schema): string | undefined {
  const resolved = resolveSchema(schema, root);
  const explicit = resolved.editor
    ?? resolved['x-prism-semantic']
    ?? resolved.semantic
    ?? resolved.annotations?.semantic;
  if (explicit) return explicit;
  const properties = resolved.properties;
  if (properties) {
    const keys = Object.keys(properties);
    if (keys.length === 1 && keys[0] === 'text' && schemaType(properties.text ?? {}, root) === 'string') {
      return 'prism.expression';
    }
    const rule = properties.rules?.items;
    if (rule?.properties?.when && rule.properties.outputs) return 'prism.decision-table';
  }
  return undefined;
}

export function schemaEnum(schema: JsonSchema): readonly unknown[] {
  if (schema.enum) return schema.enum;
  return schemaAlternatives(schema)
    .filter((alternative) => alternative.const !== undefined)
    .map((alternative) => alternative.const);
}

function defaultObject(schema: JsonSchema, root: JsonSchema): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const childDefault = createDefaultValue(child, root);
    const required = schema.required?.includes(key) ?? false;
    if (required || child.default !== undefined || childDefault !== undefined) value[key] = childDefault;
  }
  return value;
}

export function createDefaultValue(schema: JsonSchema, root: JsonSchema = schema): unknown {
  const resolved = resolveSchema(schema, root);
  if (resolved.default !== undefined) return structuredClone(resolved.default);
  if (resolved.const !== undefined) return resolved.const;
  const choices = schemaEnum(resolved);
  if (choices.length > 0) return choices[0];
  switch (schemaType(resolved, root)) {
    case 'object':
      return defaultObject(resolved, root);
    case 'array':
      return [];
    case 'boolean':
      return false;
    case 'number':
    case 'integer':
      return resolved.minimum ?? 0;
    case 'string':
      return '';
    default:
      return undefined;
  }
}

export function normalizeFieldPath(path: string): string {
  return path
    .replace(/^\/?(?:spec\/)?/, '')
    .replaceAll('/', '.')
    .replace(/\.?(\d+)(?=\.|$)/g, '[]')
    .replace(/^\./, '');
}

export function fieldPresentation(presentation: PresentationSpec | undefined, path: string): FieldPresentation {
  const normalized = normalizeFieldPath(path);
  return presentation?.fields?.[normalized] ?? presentation?.fields?.[path] ?? {};
}

export function objectFields(
  schema: JsonSchema,
  root: JsonSchema,
  presentation: PresentationSpec | undefined,
  parentPath: string,
): readonly ResolvedField[] {
  const resolved = resolveSchema(schema, root);
  return Object.entries(resolved.properties ?? {})
    .map(([key, child]) => {
      const path = parentPath ? `${parentPath}.${key}` : key;
      return {
        key,
        schema: resolveSchema(child, root),
        presentation: fieldPresentation(presentation, path),
        required: resolved.required?.includes(key) ?? false,
      };
    })
    .filter((field) => !field.presentation.hidden)
    .sort((left, right) => (left.presentation.order ?? Number.MAX_SAFE_INTEGER)
      - (right.presentation.order ?? Number.MAX_SAFE_INTEGER));
}

function diagnostic(path: string, code: string, message: string): Diagnostic {
  return { code, severity: 'error', message, path };
}

function validateScalar(schema: JsonSchema, value: unknown, path: string, type: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (type === 'string' && typeof value !== 'string') diagnostics.push(diagnostic(path, 'FORM_TYPE_STRING', '请输入文字。'));
  if ((type === 'number' || type === 'integer') && typeof value !== 'number') diagnostics.push(diagnostic(path, 'FORM_TYPE_NUMBER', '请输入数字。'));
  if (type === 'integer' && typeof value === 'number' && !Number.isInteger(value)) diagnostics.push(diagnostic(path, 'FORM_TYPE_INTEGER', '请输入整数。'));
  if (type === 'boolean' && typeof value !== 'boolean') diagnostics.push(diagnostic(path, 'FORM_TYPE_BOOLEAN', '请选择开启或关闭。'));
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) diagnostics.push(diagnostic(path, 'FORM_MIN_LENGTH', '此项不能为空。'));
    if (schema.maxLength !== undefined && value.length > schema.maxLength) diagnostics.push(diagnostic(path, 'FORM_MAX_LENGTH', `最多填写 ${schema.maxLength} 个字符。`));
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value)) diagnostics.push(diagnostic(path, 'FORM_PATTERN', '填写格式不正确。'));
      } catch {
        diagnostics.push(diagnostic(path, 'FORM_SCHEMA_PATTERN', '字段校验规则不可用。'));
      }
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) diagnostics.push(diagnostic(path, 'FORM_MINIMUM', `不能小于 ${schema.minimum}。`));
    if (schema.maximum !== undefined && value > schema.maximum) diagnostics.push(diagnostic(path, 'FORM_MAXIMUM', `不能大于 ${schema.maximum}。`));
  }
  const choices = schemaEnum(schema);
  if (choices.length > 0 && !choices.some((choice) => Object.is(choice, value))) diagnostics.push(diagnostic(path, 'FORM_ENUM', '请选择列表中的选项。'));
  return diagnostics;
}

export function validateValue(schema: JsonSchema, value: unknown, root: JsonSchema = schema, path = ''): readonly Diagnostic[] {
  const resolved = resolveSchema(schema, root);
  const type = schemaType(resolved, root);
  if (value === undefined || value === null || value === '') return [];
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [diagnostic(path, 'FORM_TYPE_OBJECT', '此部分配置格式不正确。')];
    const object = value as Record<string, unknown>;
    const diagnostics: Diagnostic[] = [];
    for (const required of resolved.required ?? []) {
      if (object[required] === undefined || object[required] === '') {
        diagnostics.push(diagnostic(path ? `${path}.${required}` : required, 'FORM_REQUIRED', '此项为必填项。'));
      }
    }
    for (const [key, child] of Object.entries(resolved.properties ?? {})) {
      diagnostics.push(...validateValue(child, object[key], root, path ? `${path}.${key}` : key));
    }
    return diagnostics;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return [diagnostic(path, 'FORM_TYPE_ARRAY', '此项应为列表。')];
    const diagnostics: Diagnostic[] = [];
    if (resolved.minItems !== undefined && value.length < resolved.minItems) diagnostics.push(diagnostic(path, 'FORM_MIN_ITEMS', `至少添加 ${resolved.minItems} 项。`));
    if (resolved.maxItems !== undefined && value.length > resolved.maxItems) diagnostics.push(diagnostic(path, 'FORM_MAX_ITEMS', `最多添加 ${resolved.maxItems} 项。`));
    if (resolved.items) value.forEach((item, index) => diagnostics.push(...validateValue(resolved.items ?? {}, item, root, `${path}.${index}`)));
    return diagnostics;
  }
  return validateScalar(resolved, value, path, type);
}
