import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidVinFormat,
  parseGvwrLowerLb,
  verifyVin,
  DEFAULT_LOW_WEIGHT_THRESHOLD_LB,
} from "../dist/index.js";

const decode = (fields) => ({
  fetchImpl: async () =>
    new Response(JSON.stringify({ Results: [{ ErrorCode: "0", ErrorText: "0", ...fields }] }), {
      status: 200,
    }),
});

test("isValidVinFormat", () => {
  assert.equal(isValidVinFormat("1FUJA6CK77LY54321"), true);
  assert.equal(isValidVinFormat(" 1fuja6ck77ly54321 "), true); // trims + upcases
  assert.equal(isValidVinFormat("1FUJA6CK77LY5432"), false); // 16 chars
  assert.equal(isValidVinFormat("1FUJA6CK77LY5432O"), false); // contains O
  assert.equal(isValidVinFormat("1FUJA6CK77LY5432I"), false); // contains I
});

test("parseGvwrLowerLb returns the range lower bound", () => {
  assert.equal(parseGvwrLowerLb("Class 8: 33,001 lb and above (14,969 kg and above)"), 33001);
  assert.equal(parseGvwrLowerLb("Class 2E: 6,001 - 7,000 lb (2,722 - 3,175 kg)"), 6001);
  assert.equal(parseGvwrLowerLb("Class 1: 6,000 lb or less"), 6000);
  assert.equal(parseGvwrLowerLb(undefined), undefined);
  assert.equal(parseGvwrLowerLb(""), undefined);
});

test("(1) invalid format is flagged with no network call", async () => {
  let called = false;
  const res = await verifyVin("NOTAVIN", {
    fetchImpl: async () => {
      called = true;
      return new Response("{}");
    },
  });
  assert.equal(called, false);
  assert.equal(res.valid, false);
  assert.equal(res.flags.invalid, true);
  assert.equal(res.flags.suspicious, true);
  assert.ok(res.flags.reasons.includes("invalid-format"));
});

test("(1) vPIC decode error is flagged invalid", async () => {
  const res = await verifyVin("1FUJA6CK77LY54321", {
    fetchImpl: async () =>
      new Response(JSON.stringify({ Results: [{ ErrorCode: "1", ErrorText: "1 - Check digit..." }] }), {
        status: 200,
      }),
  });
  assert.equal(res.valid, false);
  assert.equal(res.flags.invalid, true);
  assert.ok(res.flags.reasons.some((r) => r.startsWith("vpic-error:")));
});

test("(2) passenger car is flagged unlikely (type + low GVWR)", async () => {
  const res = await verifyVin("4T1B11HK5JU000000", decode({
    Make: "TOYOTA",
    Model: "Camry",
    ModelYear: "2018",
    VehicleType: "PASSENGER CAR",
    BodyClass: "Sedan/Saloon",
    GVWR: "Class 1D: 5,001 - 6,000 lb (2,268 - 2,722 kg)",
  }));
  assert.equal(res.valid, true);
  assert.equal(res.make, "TOYOTA");
  assert.equal(res.model, "Camry");
  assert.equal(res.flags.unlikelyHvut, true);
  assert.equal(res.flags.suspicious, true);
  assert.ok(res.flags.reasons.some((r) => r.startsWith("unlikely-type:")));
  assert.ok(res.flags.reasons.some((r) => r.startsWith("low-gvwr:")));
});

test("(2) motorcycle is flagged unlikely even with no GVWR", async () => {
  const res = await verifyVin("1HD1KB4197Y000000", decode({
    Make: "HARLEY-DAVIDSON",
    VehicleType: "MOTORCYCLE",
    GVWR: "",
  }));
  assert.equal(res.valid, true);
  assert.equal(res.flags.unlikelyHvut, true);
});

test("(2) MPV/SUV is flagged unlikely", async () => {
  const res = await verifyVin("5J6RW2H80KA000000", decode({
    Make: "HONDA",
    Model: "CR-V",
    VehicleType: "MULTIPURPOSE PASSENGER VEHICLE (MPV)",
    GVWR: "Class 1D: 5,001 - 6,000 lb",
  }));
  assert.equal(res.flags.unlikelyHvut, true);
});

test("(2/3) heavy truck passes with make/model and no flags", async () => {
  const res = await verifyVin("1FUJA6CK77LY00000", decode({
    Make: "FREIGHTLINER",
    Model: "Cascadia",
    ModelYear: "2020",
    VehicleType: "TRUCK",
    BodyClass: "Truck-Tractor",
    GVWR: "Class 8: 33,001 lb and above (14,969 kg and above)",
  }));
  assert.equal(res.valid, true);
  assert.equal(res.make, "FREIGHTLINER");
  assert.equal(res.model, "Cascadia");
  assert.equal(res.gvwrLbLower, 33001);
  assert.equal(res.flags.unlikelyHvut, false);
  assert.equal(res.flags.suspicious, false);
  assert.ok(DEFAULT_LOW_WEIGHT_THRESHOLD_LB > 5000);
});
