import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidVinFormat,
  parseGvwrClass,
  parseGvwrLowerLb,
  verifyVin,
} from "../dist/index.js";

const decode = (fields) => ({
  fetchImpl: async () =>
    new Response(JSON.stringify({ Results: [{ ErrorCode: "0", ErrorText: "0", ...fields }] }), {
      status: 200,
    }),
});

test("isValidVinFormat", () => {
  assert.equal(isValidVinFormat("1FUJA6CK77LY54321"), true);
  assert.equal(isValidVinFormat(" 1fuja6ck77ly54321 "), true);
  assert.equal(isValidVinFormat("1FUJA6CK77LY5432"), false); // 16 chars
  assert.equal(isValidVinFormat("1FUJA6CK77LY5432O"), false); // contains O
});

test("parseGvwrClass", () => {
  assert.equal(parseGvwrClass("Class 7: 26,001 - 33,000 lb (11,794 - 14,969 kg)"), 7);
  assert.equal(parseGvwrClass("Class 2E: 6,001 - 7,000 lb"), 2);
  assert.equal(parseGvwrClass("Class 8: 33,001 lb and above"), 8);
  assert.equal(parseGvwrClass(undefined), undefined);
});

test("parseGvwrLowerLb", () => {
  assert.equal(parseGvwrLowerLb("Class 8: 33,001 lb and above"), 33001);
  assert.equal(parseGvwrLowerLb("Class 6: 19,501 - 26,000 lb"), 19501);
  assert.equal(parseGvwrLowerLb(undefined), undefined);
});

test("(1) invalid format flagged, no network call", async () => {
  let called = false;
  const res = await verifyVin("NOTAVIN", {
    fetchImpl: async () => { called = true; return new Response("{}"); },
  });
  assert.equal(called, false);
  assert.equal(res.flags.invalid, true);
  assert.equal(res.flags.suspicious, true);
  assert.ok(res.flags.reasons.includes("invalid-format"));
});

test("(1) vPIC decode error flagged invalid", async () => {
  const res = await verifyVin("1FUJA6CK77LY54321", {
    fetchImpl: async () =>
      new Response(JSON.stringify({ Results: [{ ErrorCode: "1", ErrorText: "check digit" }] }), { status: 200 }),
  });
  assert.equal(res.valid, false);
  assert.equal(res.flags.invalid, true);
  assert.ok(res.flags.reasons.some((r) => r.startsWith("vpic-error:")));
});

test("(2) STRONG: passenger car -> veryUnlikelyHvut", async () => {
  const res = await verifyVin("4T1B11HK5JU000000", decode({
    Make: "TOYOTA", Model: "Camry", VehicleType: "PASSENGER CAR",
    BodyClass: "Sedan/Saloon", GVWR: "Class 1D: 5,001 - 6,000 lb",
  }));
  assert.equal(res.valid, true);
  assert.equal(res.make, "TOYOTA");
  assert.equal(res.flags.veryUnlikelyHvut, true);
  assert.equal(res.flags.unlikelyHvut, false);
});

test("(2) STRONG: motorcycle -> veryUnlikelyHvut (no GVWR)", async () => {
  const res = await verifyVin("1HD1KB4197Y000000", decode({
    Make: "HARLEY-DAVIDSON", VehicleType: "MOTORCYCLE", GVWR: "",
  }));
  assert.equal(res.flags.veryUnlikelyHvut, true);
});

test("(2) STRONG: pickup body (type TRUCK) -> veryUnlikelyHvut", async () => {
  const res = await verifyVin("1FTFW1E50JF000000", decode({
    Make: "FORD", Model: "F-150", VehicleType: "TRUCK",
    BodyClass: "Pickup", GVWR: "Class 2E: 6,001 - 7,000 lb",
  }));
  assert.equal(res.flags.veryUnlikelyHvut, true);
  assert.ok(res.flags.reasons.some((r) => r.startsWith("very-unlikely-body:")));
});

test("(2) GVWR class 6 straight truck -> unlikelyHvut (warn, not strong)", async () => {
  const res = await verifyVin("1FVACWDT5HH000000", decode({
    Make: "FREIGHTLINER", VehicleType: "TRUCK", BodyClass: "Truck",
    GVWR: "Class 6: 19,501 - 26,000 lb (8,846 - 11,793 kg)",
  }));
  assert.equal(res.flags.veryUnlikelyHvut, false);
  assert.equal(res.flags.unlikelyHvut, true);
  assert.equal(res.flags.suspicious, true);
  assert.ok(res.flags.reasons.some((r) => r.startsWith("gvwr-class-1-6:")));
});

test("(2) GVWR class 7 -> no flags (fine for 2290)", async () => {
  const res = await verifyVin("1FVACWDT5HH000001", decode({
    Make: "FREIGHTLINER", VehicleType: "TRUCK", BodyClass: "Truck",
    GVWR: "Class 7: 26,001 - 33,000 lb (11,794 - 14,969 kg)",
  }));
  assert.equal(res.valid, true);
  assert.equal(res.flags.veryUnlikelyHvut, false);
  assert.equal(res.flags.unlikelyHvut, false);
  assert.equal(res.flags.suspicious, false);
});

test("(2/3) class 8 truck-tractor -> clean, make/model returned", async () => {
  const res = await verifyVin("1FUJA6CK77LY00000", decode({
    Make: "FREIGHTLINER", Model: "Cascadia", ModelYear: "2020",
    VehicleType: "TRUCK", BodyClass: "Truck-Tractor",
    GVWR: "Class 8: 33,001 lb and above (14,969 kg and above)",
  }));
  assert.equal(res.valid, true);
  assert.equal(res.make, "FREIGHTLINER");
  assert.equal(res.model, "Cascadia");
  assert.equal(res.gvwrClass, 8);
  assert.equal(res.flags.veryUnlikelyHvut, false);
  assert.equal(res.flags.unlikelyHvut, false);
  assert.equal(res.flags.suspicious, false);
});
