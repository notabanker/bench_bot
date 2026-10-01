import { describe, expect, it } from "vitest";
import {
  Kernel,
  ServiceAlreadyRegisteredError,
  ServiceKey,
  ServiceMissingError,
} from "./kernel.ts";

interface Greeter {
  greet(name: string): string;
}
const greeterKey = new ServiceKey<Greeter>("greeter");

describe("Kernel", () => {
  it("returns the service registered under a key", () => {
    const kernel = new Kernel();
    const greeter: Greeter = { greet: (name) => `hi ${name}` };
    kernel.register(greeterKey, greeter);
    expect(kernel.get(greeterKey)).toBe(greeter);
    expect(kernel.get(greeterKey).greet("bot")).toBe("hi bot");
  });

  it("throws a clear error for a missing service", () => {
    const kernel = new Kernel();
    expect(() => kernel.get(greeterKey)).toThrow(ServiceMissingError);
    expect(() => kernel.get(greeterKey)).toThrow('Service "greeter" is not registered');
  });

  it("refuses to register the same service twice and keeps the first one", () => {
    const kernel = new Kernel();
    const first: Greeter = { greet: () => "first" };
    kernel.register(greeterKey, first);
    expect(() => kernel.register(greeterKey, { greet: () => "second" })).toThrow(
      ServiceAlreadyRegisteredError,
    );
    expect(kernel.get(greeterKey)).toBe(first);
  });

  it("treats two keys with the same name as the same service", () => {
    const kernel = new Kernel();
    kernel.register(greeterKey, { greet: () => "x" });
    expect(kernel.has(new ServiceKey<Greeter>("greeter"))).toBe(true);
  });

  it("keeps kernels independent and lists names in order", () => {
    const a = new Kernel();
    const b = new Kernel();
    a.register(greeterKey, { greet: () => "a" });
    a.register(new ServiceKey<number>("answer"), 42);
    expect(b.has(greeterKey)).toBe(false);
    expect(a.names()).toEqual(["greeter", "answer"]);
  });
});
