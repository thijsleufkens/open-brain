import { describe, it, expect } from "vitest";
import { l2Normalize } from "../src/utils/normalize.js";

describe("l2Normalize", () => {
  it("normalizes a vector to unit length", () => {
    const vec = new Float32Array([3, 4]);
    l2Normalize(vec);
    // 3/5 = 0.6, 4/5 = 0.8
    expect(vec[0]).toBeCloseTo(0.6, 5);
    expect(vec[1]).toBeCloseTo(0.8, 5);
  });

  it("preserves direction", () => {
    const vec = new Float32Array([1, 2, 3]);
    const ratio12 = vec[0] / vec[1];
    const ratio23 = vec[1] / vec[2];
    l2Normalize(vec);
    expect(vec[0] / vec[1]).toBeCloseTo(ratio12, 5);
    expect(vec[1] / vec[2]).toBeCloseTo(ratio23, 5);
  });

  it("results in unit length", () => {
    const vec = new Float32Array([1, 2, 3, 4, 5]);
    l2Normalize(vec);
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it("handles zero vector gracefully", () => {
    const vec = new Float32Array([0, 0, 0]);
    l2Normalize(vec);
    expect(vec[0]).toBe(0);
    expect(vec[1]).toBe(0);
    expect(vec[2]).toBe(0);
  });

  it("handles single-element vector", () => {
    const vec = new Float32Array([5]);
    l2Normalize(vec);
    expect(vec[0]).toBeCloseTo(1.0, 5);
  });
});
