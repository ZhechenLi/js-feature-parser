import definitions from '../data/definitions';
import {
  createImport,
  isPolyfillSource,
  isRequire
} from '@babel/preset-env/lib/utils';

function has(obj: Object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function getType(target: any): string {
  if (Array.isArray(target)) return 'array';
  return typeof target;
}

export default function({ types: t }) {
  function addImport(
    path: Object,
    builtIn: string,
    builtIns: Set<string>
  ): void {
    if (builtIn && !builtIns.has(builtIn)) {
      builtIns.add(builtIn);
      createImport(path, builtIn);
    }
  }

  function addUnsupported(
    path: Object,
    polyfills: Set<string>,
    builtIn: Array<string> | string,
    builtIns: Set<string>
  ): void {
    if (Array.isArray(builtIn)) {
      for (const i of builtIn) {
        if (polyfills.has(i)) {
          addImport(path, i, builtIns);
        }
      }
    } else {
      if (polyfills.has(builtIn)) {
        addImport(path, builtIn, builtIns);
      }
    }
  }

  const addAndRemovePolyfillImports = {
    ImportDeclaration(path) {
      if (
        path.node.specifiers.length === 0 &&
        isPolyfillSource(path.node.source.value)
      ) {
        console.warn(
          `
  When setting \`useBuiltIns: 'usage'\`, polyfills are automatically imported when needed.
  Please remove the \`import '@babel/polyfill'\` call or use \`useBuiltIns: 'entry'\` instead.`
        );
        path.remove();
      }
    },
    Program: {
      enter(path) {
        path.get('body').forEach(bodyPath => {
          if (isRequire(t, bodyPath)) {
            console.warn(
              `
  When setting \`useBuiltIns: 'usage'\`, polyfills are automatically imported when needed.
  Please remove the \`require('@babel/polyfill')\` call or use \`useBuiltIns: 'entry'\` instead.`
            );
            bodyPath.remove();
          }
        });
      }
    },

    // Symbol()
    // new Promise
    ReferencedIdentifier(path, state) {
      const { node, parent, scope } = path;

      if (t.isMemberExpression(parent)) return;
      if (!has(definitions.builtins, node.name)) return;
      if (scope.getBindingIdentifier(node.name)) return;

      const builtIn = definitions.builtins[node.name];
      addUnsupported(path, state.opts.polyfills, builtIn, this.builtIns);
    },

    // arr[Symbol.iterator]()
    CallExpression(path) {
      // we can't compile this
      if (path.node.arguments.length) return;

      const callee = path.node.callee;
      if (!t.isMemberExpression(callee)) return;
      if (!callee.computed) return;
      if (!path.get('callee.property').matchesPattern('Symbol.iterator')) {
        return;
      }

      addImport(path, 'web.dom.iterable', this.builtIns);
    },

    // Symbol.iterator in arr
    BinaryExpression(path) {
      if (path.node.operator !== 'in') return;
      if (!path.get('left').matchesPattern('Symbol.iterator')) return;

      addImport(path, 'web.dom.iterable', this.builtIns);
    },

    // yield*
    YieldExpression(path) {
      if (!path.node.delegate) return;

      addImport(path, 'web.dom.iterable', this.builtIns);
    },

    // Array.from Array.protype.includes
    MemberExpression: {
      enter(path, state) {
        if (!path.isReferenced()) return;

        const { node } = path;
        const obj = node.object;
        const prop = node.property;

        if (!t.isReferenced(obj, node)) return;
        let instanceType;
        let evaluatedPropType = obj.name;
        let propName = prop.name;
        if (node.computed) {
          if (t.isStringLiteral(prop)) {
            propName = prop.value;
          } else {
            const res = path.get('property').evaluate();
            if (res.confident && res.value) {
              propName = res.value;
            }
          }
        }

        if (
          path.scope.getBindingIdentifier(obj.name) ||
          !t.isIdentifier(path.get('object').node)
        ) {
          // 当前作用域下是否有 obj.name 这个声明, 没有考虑声明直接调用方法 [1,2,3].includes 的情况 Object.entries 也会命中 array.prototype.entries,擦
          const result = path.get('object').evaluate();
          if (result.value) {
            // NOTE: '' will be fall BUG
            instanceType = getType(result.value);
          } else if (result.deopt && result.deopt.isIdentifier()) {
            evaluatedPropType = result.deopt.node.name;
          }
        }
        if (has(definitions.staticMethods, evaluatedPropType)) {
          // 查看当前方法是否为静态方法
          const staticMethods = definitions.staticMethods[evaluatedPropType];
          if (has(staticMethods, propName)) {
            const builtIn = staticMethods[propName];
            addUnsupported(path, state.opts.polyfills, builtIn, this.builtIns);
            // if (obj.name === "Array" && prop.name === "from") {
            //   addImport(
            //     path,
            //     "@babel/polyfill/lib/core-js/modules/web.dom.iterable",
            //     this.builtIns,
            //   );
            // }
          }
        }

        if (has(definitions.instanceMethods, propName)) {
          //warnOnInstanceMethod(state, getObjectString(node));
          let builtIn = definitions.instanceMethods[propName];
          if (instanceType) {
            builtIn = builtIn.filter(item =>
              item.includes(
                `${instanceType[0].toUpperCase()}${instanceType.slice(1)}`
              )
            );
          }
          addUnsupported(path, state.opts.polyfills, builtIn, this.builtIns);
        }
      },

      // Symbol.match
      exit(path, state) {
        if (!path.isReferenced()) return;

        const { node } = path;
        const obj = node.object;

        if (!has(definitions.builtins, obj.name)) return;
        if (path.scope.getBindingIdentifier(obj.name)) return;

        const builtIn = definitions.builtins[obj.name];
        addUnsupported(path, state.opts.polyfills, builtIn, this.builtIns);
      }
    },

    // var { repeat, startsWith } = String
    VariableDeclarator(path, state) {
      if (!path.isReferenced()) return;

      const { node } = path;
      const obj = node.init;

      if (!t.isObjectPattern(node.id)) return;
      if (!t.isReferenced(obj, node)) return;

      // doesn't reference the global
      if (obj && path.scope.getBindingIdentifier(obj.name)) return;

      for (let prop of node.id.properties) {
        prop = prop.key;
        if (
          !node.computed &&
          t.isIdentifier(prop) &&
          has(definitions.instanceMethods, prop.name)
        ) {
          // warnOnInstanceMethod(
          //   state,
          //   `${path.parentPath.node.kind} { ${prop.name} } = ${obj.name}`,
          // );

          const builtIn = definitions.instanceMethods[prop.name];
          addUnsupported(path, state.opts.polyfills, builtIn, this.builtIns);
        }
      }
    },

    Function(path, state) {
      if (!this.usesRegenerator && (path.node.generator || path.node.async)) {
        this.usesRegenerator = true;
        if (state.opts.regenerator) {
          addImport(path, 'regenerator-runtime', this.builtIns);
        }
      }
    }
  };

  return {
    name: 'feature-parser-include-bom',
    pre() {
      this.builtIns = new Set();
      this.usesRegenerator = false;
    },
    post() {
      // NOTE 结束的时候来到这里
      const { debug, onDebug } = this.opts;
      console.log(this.builtIns);

      // NOTE builtIns 里有已提取出来的部分 feature
    },
    visitor: addAndRemovePolyfillImports
  };
}
