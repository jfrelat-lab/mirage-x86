// TypeScript on MIRAGE's node: tsc hello.ts && node hello.js
interface Shape { kind: 'circle' | 'square'; size: number }

const area = (s: Shape): number => (s.kind === 'circle' ? Math.PI * s.size ** 2 : s.size ** 2);

class Greeter<T> {
  constructor(private readonly who: T) {}
  greet(): string { return `hello from ${this.who}`; }
}

const shapes: Shape[] = [{ kind: 'circle', size: 1 }, { kind: 'square', size: 2 }];
console.log(new Greeter('tsc').greet());
for (const s of shapes) console.log(s.kind, area(s).toFixed(2));
