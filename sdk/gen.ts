#!/usr/bin/env bun
/**
 * Codegen: reads browser_protocol.json + js_protocol.json, writes generated.ts
 * with full TypeScript types and a `bindDomains(transport)` factory that
 * returns `{ Page: { navigate(...), ... }, DOM: { ... }, ... }`.
 *
 * Skip events. Include experimental/deprecated. Skip redirected commands
 * (the redirect target's domain has the canonical version).
 */

const HERE = import.meta.dir;

type Prop = {
  name: string;
  description?: string;
  optional?: boolean;
  type?: string;
  $ref?: string;
  items?: Prop;
  properties?: Prop[];
  enum?: string[];
};

type CdpType = {
  id: string;
  description?: string;
  type?: string;
  $ref?: string;
  items?: Prop;
  properties?: Prop[];
  enum?: string[];
};

type Command = {
  name: string;
  description?: string;
  experimental?: boolean;
  deprecated?: boolean;
  redirect?: string;
  parameters?: Prop[];
  returns?: Prop[];
};

type Domain = {
  domain: string;
  description?: string;
  experimental?: boolean;
  deprecated?: boolean;
  types?: CdpType[];
  commands?: Command[];
};

const RESERVED = new Set([
  'this', 'class', 'function', 'enum', 'extends', 'super', 'import', 'export',
  'default', 'new', 'delete', 'typeof', 'instanceof', 'void', 'null', 'true',
  'false', 'in', 'of', 'do', 'if', 'else', 'switch', 'case', 'break', 'continue',
  'return', 'while', 'for', 'try', 'catch', 'finally', 'throw', 'with',
  'debugger', 'var', 'let', 'const',
]);

async function loadDomains(): Promise<Domain[]> {
  const out: Domain[] = [];
  for (const fn of ['browser_protocol.json', 'js_protocol.json']) {
    const data = await Bun.file(`${HERE}/${fn}`).json();
    out.push(...(data.domains as Domain[]));
  }
  out.sort((a, b) => a.domain.localeCompare(b.domain));
  return out;
}

function escId(name: string): string {
  if (RESERVED.has(name) || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
    return JSON.stringify(name);
  }
  return name;
}

function jsdocLines(text: string | undefined, indent: string): string {
  if (!text) return '';
  // Escape `*/` so it doesn't close the JSDoc block early.
  const safe = text.replace(/\*\//g, '*\\/');
  const lines = safe.split(/\r?\n/);
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  return `${indent}/**\n${lines.map(l => `${indent} * ${l}`).join('\n')}\n${indent} */\n`;
}

/** Render a type (Prop or CdpType) to a TS type string in the context of `currentDomain`. */
function renderType(p: Prop | CdpType, currentDomain: string): string {
  if (p.$ref) {
    const ref = p.$ref;
    if (ref.includes('.')) return ref; // qualified -> use as-is (Domain.Type)
    return `${currentDomain}.${ref}`;
  }
  switch (p.type) {
    case 'string':
      if (p.enum) return p.enum.map(v => JSON.stringify(v)).join(' | ');
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'binary':
      return 'string'; // base64-encoded
    case 'any':
      return 'unknown';
    case 'array': {
      const inner = p.items ? renderType(p.items as Prop, currentDomain) : 'unknown';
      return `${inner}[]`;
    }
    case 'object': {
      if (p.properties) return renderObject(p.properties, currentDomain, '  ');
      return 'Record<string, unknown>';
    }
    default:
      return 'unknown';
  }
}

function renderObject(props: Prop[], currentDomain: string, indent: string): string {
  const inner = props.map(pr => {
    const opt = pr.optional ? '?' : '';
    const t = renderType(pr, currentDomain);
    return `${indent}  ${escId(pr.name)}${opt}: ${t};`;
  }).join('\n');
  return `{\n${inner}\n${indent}}`;
}

/** Top-level type definition for a domain's `types[]`. */
function renderTypeDef(t: CdpType, currentDomain: string): string {
  const doc = jsdocLines(t.description, '  ');
  // Object type → interface
  if (t.type === 'object' && t.properties) {
    const body = t.properties.map(pr => {
      const pdoc = jsdocLines(pr.description, '    ');
      const opt = pr.optional ? '?' : '';
      const ty = renderType(pr, currentDomain);
      return `${pdoc}    ${escId(pr.name)}${opt}: ${ty};`;
    }).join('\n');
    return `${doc}  export interface ${t.id} {\n${body}\n  }`;
  }
  // Enum string union
  if (t.type === 'string' && t.enum) {
    return `${doc}  export type ${t.id} = ${t.enum.map(v => JSON.stringify(v)).join(' | ')};`;
  }
  // Otherwise alias (string/number/array/etc.)
  const alias = renderType(t as unknown as Prop, currentDomain);
  return `${doc}  export type ${t.id} = ${alias};`;
}

/** Param/return interface. Returns the body (without surrounding interface keyword). */
function renderInterfaceBody(props: Prop[], currentDomain: string): string {
  return props.map(pr => {
    const pdoc = jsdocLines(pr.description, '    ');
    const opt = pr.optional ? '?' : '';
    const t = renderType(pr, currentDomain);
    return `${pdoc}    ${escId(pr.name)}${opt}: ${t};`;
  }).join('\n');
}

function isAllOptional(props: Prop[] | undefined): boolean {
  if (!props || props.length === 0) return true;
  return props.every(p => p.optional);
}

async function build() {
  const domains = await loadDomains();

  // Skip empty/no-command domains? No — keep all so types resolve. But only
  // bind methods for non-redirected commands.

  const out: string[] = [];
  out.push(`/* eslint-disable */\n// AUTO-GENERATED by gen.ts. Do not edit by hand.\n// Run \`bun gen.ts\` to regenerate from browser_protocol.json + js_protocol.json.\n`);

  // Transport interface
  out.push(`export interface Transport {\n  _call(method: string, params?: unknown): Promise<unknown>;\n}\n`);

  // ---- Type namespaces ----
  for (const d of domains) {
    out.push(`\nexport namespace ${d.domain} {`);
    if (!d.types || d.types.length === 0) {
      out.push(`  // (no types)\n}`);
      continue;
    }
    out.push('');
    for (const t of d.types) {
      out.push(renderTypeDef(t, d.domain));
      out.push('');
    }
    out.push(`}`);
  }

  // ---- Param/return interfaces (also under domain namespaces) ----
  // Strategy: for each command, emit `Domain.<Name>Params` and `Domain.<Name>Return`
  // inside a second namespace block (TS allows merging multiple namespace decls).
  for (const d of domains) {
    if (!d.commands) continue;
    const realCmds = d.commands.filter(c => !c.redirect);
    if (realCmds.length === 0) continue;
    out.push(`\nexport namespace ${d.domain} {`);
    for (const c of realCmds) {
      const capName = c.name.charAt(0).toUpperCase() + c.name.slice(1);
      // Params
      if (c.parameters && c.parameters.length > 0) {
        const body = renderInterfaceBody(c.parameters, d.domain);
        out.push(`  export interface ${capName}Params {\n${body}\n  }`);
      } else {
        out.push(`  export interface ${capName}Params {}`);
      }
      // Return
      if (c.returns && c.returns.length > 0) {
        const body = renderInterfaceBody(c.returns, d.domain);
        out.push(`  export interface ${capName}Return {\n${body}\n  }`);
      } else {
        out.push(`  export type ${capName}Return = void;`);
      }
    }
    out.push(`}`);
  }

  // ---- Domains interface (the shape of session.* domain bindings) ----
  out.push(`\nexport interface Domains {`);
  for (const d of domains) {
    if (!d.commands) continue;
    const realCmds = d.commands.filter(c => !c.redirect);
    if (realCmds.length === 0) continue;
    out.push(`  ${d.domain}: {`);
    for (const c of realCmds) {
      const capName = c.name.charAt(0).toUpperCase() + c.name.slice(1);
      const cdoc = jsdocLines(c.description, '    ');
      const noParams = !c.parameters || c.parameters.length === 0;
      const allOpt = isAllOptional(c.parameters);
      const paramSig = noParams
        ? `()`
        : allOpt
          ? `(params?: ${d.domain}.${capName}Params)`
          : `(params: ${d.domain}.${capName}Params)`;
      const retType = c.returns && c.returns.length > 0
        ? `${d.domain}.${capName}Return`
        : 'void';
      out.push(`${cdoc}    ${escId(c.name)}: ${paramSig} => Promise<${retType}>;`);
    }
    out.push(`  };`);
  }
  out.push(`}`);

  // ---- bindDomains factory ----
  out.push(`\nexport function bindDomains(t: Transport): Domains {\n  return {`);
  for (const d of domains) {
    if (!d.commands) continue;
    const realCmds = d.commands.filter(c => !c.redirect);
    if (realCmds.length === 0) continue;
    out.push(`    ${d.domain}: {`);
    for (const c of realCmds) {
      const fq = `${d.domain}.${c.name}`;
      out.push(`      ${escId(c.name)}: (params?: any) => t._call(${JSON.stringify(fq)}, params) as any,`);
    }
    out.push(`    },`);
  }
  out.push(`  };\n}\n`);

  // ---- Stats footer (for sanity) ----
  const totalCmds = domains.reduce((n, d) => n + (d.commands?.filter(c => !c.redirect).length ?? 0), 0);
  const totalTypes = domains.reduce((n, d) => n + (d.types?.length ?? 0), 0);
  out.push(`// Stats: ${domains.length} domains, ${totalCmds} commands (excl. redirects), ${totalTypes} types\n`);

  const text = out.join('\n');
  const target = `${HERE}/generated.ts`;
  await Bun.write(target, text);
  console.log(`Wrote ${target} (${text.length.toLocaleString()} bytes)`);
  console.log(`Domains: ${domains.length} | Commands: ${totalCmds} | Types: ${totalTypes}`);
}

await build();
