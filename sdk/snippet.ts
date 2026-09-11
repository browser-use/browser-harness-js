import type { ScopedSession, Session } from './session.ts';

type EvalSession = Session | ScopedSession;

function isExpression(code: string): boolean {
  const trimmed = code.trim();
  if (!trimmed) return false;
  if (/[;\n]/.test(trimmed)) return false;
  if (/^(let|const|var|if|for|while|do|switch|class|function|throw|try|return|import|export)\b/.test(trimmed)) return false;
  return true;
}

/**
 * 在一次 /eval 请求中执行代码，同时把 `session` 和 `globalThis.session`
 * 都绑定到该请求自己的 Session 视图。
 *
 * 这里不用函数参数名 `session`：否则用户 snippet 里的 `const session = ...`
 * 会和参数重名并在解析阶段直接失败。改用 `with` 的对象环境后，普通的自由变量
 * `session` 仍然解析到请求级 Session，而用户自己声明的局部 `session` 可以自然遮蔽它。
 *
 * `globalThis` 也提供一个每请求 Proxy，只覆写 `.session`；其他属性仍直接读写真正的
 * globalThis，所以原有的 `globalThis.foo = ...` 跨请求持久化能力保持不变。
 */
export async function runSnippet(code: string, evalSession: EvalSession): Promise<unknown> {
  const body = isExpression(code) ? `return (${code});` : code;

  const requestGlobal = new Proxy(globalThis, {
    get(target, prop, receiver) {
      if (prop === 'session') return evalSession;
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value, receiver) {
      if (prop === 'session') {
        throw new Error('globalThis.session is request-scoped and cannot be reassigned');
      }
      return Reflect.set(target, prop, value, receiver);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop === 'session') {
        return { configurable: true, enumerable: true, writable: false, value: evalSession };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });

  const scope = new Proxy(Object.create(null) as Record<PropertyKey, unknown>, {
    has(_target, prop) {
      return prop === 'session' || prop === 'globalThis';
    },
    get(_target, prop) {
      if (prop === Symbol.unscopables) return undefined;
      if (prop === 'session') return evalSession;
      if (prop === 'globalThis') return requestGlobal;
      return undefined;
    },
  });

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;
  const fn = new AsyncFunction('__browserHarnessScope', `with (__browserHarnessScope) { ${body} }`);
  return await fn(scope);
}
