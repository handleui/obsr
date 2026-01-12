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
