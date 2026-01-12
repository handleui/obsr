// This file has intentional type errors for testing CI
const x: number = "not a number";
const y: string = 42;

// Unused variable (lint error)
const unused = "this is unused";

export const broken = () => {
  return x + y;
};

// More type errors
const z: boolean = "also wrong";
const arr: number[] = "not an array";

// Even more errors to trigger CI
const obj: { name: string } = { name: 123 };
const fn: () => void = "not a function";

// Trigger #4
const tuple: [string, number] = [1, "wrong order"];

// Trigger #5 - permissions accepted now
const promise: Promise<string> = 42;
