/**
 * gideon-vin — verify and decode US vehicle VINs via the public NHTSA vPIC API,
 * for IRS Form 2290 (Heavy Highway Vehicle Use Tax) VIN detection.
 *
 * It does three things:
 *   1. Flags an invalid VIN (bad format, or vPIC can't decode it) — always.
 *   2. Flags a vehicle that is unlikely to be a Form 2290 vehicle — passenger
 *      cars, SUVs/MPVs, motorcycles, light pickups/vans, trailers, etc. — using
 *      the decoded vehicle type, body class, and gross weight rating.
 *   3. Returns the vehicle's make, model (and year, type, body class).
 *
 * Released by Gideon Solutions, LLC under the Gideon Christian Open Source
 * License, Version 1.0 (see LICENSE.md).
 *
 * No dependencies; uses the global `fetch` (Node 18+, browsers, edge runtimes).
 */

const VPIC_BASE = "https://vpic.nhtsa.dot.gov/api/vehicles";

/** 17 characters, A–Z and 0–9, excluding I, O, Q (the standard VIN alphabet). */
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

/**
 * GVWR lower bound (lb) below which a vehicle is treated as too light to be a
 * Heavy Highway Vehicle Use Tax vehicle. 26,000 lb is the top of Class 6; a real
 * Form 2290 truck is Class 7–8, so a lighter rating means a car, van, or
 * light/medium pickup rather than a heavy highway vehicle.
 */
export const DEFAULT_LOW_WEIGHT_THRESHOLD_LB = 26_000;

/**
 * vPIC `VehicleType` values that are never Form 2290 vehicles regardless of
 * weight. (Light pickups/vans decode as "TRUCK" and are caught by the GVWR
 * check instead.)
 */
const UNLIKELY_VEHICLE_TYPES = new Set([
  "PASSENGER CAR",
  "MULTIPURPOSE PASSENGER VEHICLE (MPV)",
  "MOTORCYCLE",
  "LOW SPEED VEHICLE (LSV)",
  "TRAILER",
]);

/** True when `vin` is 17 valid VIN characters (does not check the check digit). */
export function isValidVinFormat(vin: string): boolean {
  return VIN_RE.test(vin.trim().toUpperCase());
}

/**
 * Parse the lower-bound weight in pounds from a vPIC GVWR class string.
 * The lower bound is the first number after the "Class X:" label:
 *   "Class 8: 33,001 lb and above (...)"      → 33001
 *   "Class 2E: 6,001 - 7,000 lb (...)"         → 6001
 *   "Class 1: 6,000 lb or less"                → 6000
 */
export function parseGvwrLowerLb(gvwr: string | null | undefined): number | undefined {
  if (!gvwr) return undefined;
  const afterLabel = gvwr.includes(":") ? gvwr.slice(gvwr.indexOf(":") + 1) : gvwr;
  const m = afterLabel.replace(/,/g, "").match(/\d{3,}/); // first 3+ digit number (skips the class digit)
  return m ? Number(m[0]) : undefined;
}

export interface VinFlags {
  /** The VIN format is invalid, or vPIC could not decode it. Always evaluated. */
  invalid: boolean;
  /** The vehicle is unlikely to be a Form 2290 vehicle (car, SUV/MPV, motorcycle,
   *  light pickup/van, trailer, or a low gross weight rating). */
  unlikelyHvut: boolean;
  /** True if any flag above is set — surface a warning to the filer. */
  suspicious: boolean;
  /** Machine-readable reasons, e.g. "invalid-format", "vpic-error:1",
   *  "unlikely-type:PASSENGER CAR", "low-gvwr:6001lb<26000lb". */
  reasons: string[];
}

export interface VinResult {
  vin: string;
  /** True when vPIC returned a clean decode (ErrorCode "0") and the format is valid. */
  valid: boolean;
  errorCode: string;
  errorText: string;
  make?: string;
  model?: string;
  modelYear?: string;
  vehicleType?: string;
  bodyClass?: string;
  /** Raw vPIC GVWR class string. */
  gvwr?: string;
  /** Lower bound of the GVWR range in pounds, parsed from `gvwr`. */
  gvwrLbLower?: number;
  flags: VinFlags;
  /** The full vPIC `Results[0]` object. */
  raw: Record<string, string>;
}

export interface VerifyVinOptions {
  /** GVWR lower bound (lb) under which the vehicle is flagged. Default 26,000. */
  lowWeightThresholdLb?: number;
  /** Override the fetch implementation (testing, or runtimes without global fetch). */
  fetchImpl?: typeof fetch;
  /** Request timeout in milliseconds. Default 10,000. */
  timeoutMs?: number;
  /** Optional model-year hint passed to vPIC for more accurate decoding. */
  modelYear?: string | number;
}

function baseResult(vin: string): VinResult {
  return {
    vin,
    valid: false,
    errorCode: "",
    errorText: "",
    flags: { invalid: true, unlikelyHvut: false, suspicious: true, reasons: [] },
    raw: {},
  };
}

/**
 * Verify and decode a single VIN. Never throws for network/HTTP errors — it
 * returns a result whose `flags.invalid` is true and `flags.reasons` explains
 * why, so a caller can surface a soft warning without breaking a filing flow.
 * (It throws only if no `fetch` is available and none was provided.)
 */
export async function verifyVin(
  vin: string,
  opts: VerifyVinOptions = {},
): Promise<VinResult> {
  const cleaned = vin.trim().toUpperCase();
  const threshold = opts.lowWeightThresholdLb ?? DEFAULT_LOW_WEIGHT_THRESHOLD_LB;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new Error(
      "gideon-vin: no global fetch available — pass opts.fetchImpl on this runtime.",
    );
  }

  const result = baseResult(cleaned);

  // (1) Invalid format — flagged without a network call.
  if (!isValidVinFormat(cleaned)) {
    result.errorText =
      "VIN must be 17 characters using A–Z (except I, O, Q) and 0–9.";
    result.flags.reasons.push("invalid-format");
    return result;
  }

  const params = new URLSearchParams({ format: "json" });
  if (opts.modelYear != null) params.set("modelyear", String(opts.modelYear));
  const url = `${VPIC_BASE}/DecodeVinValues/${encodeURIComponent(cleaned)}?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  let payload: { Results?: Array<Record<string, string>> };
  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      result.errorText = `vPIC request failed (HTTP ${res.status}).`;
      result.flags.reasons.push("vpic-unavailable");
      return result;
    }
    payload = (await res.json()) as { Results?: Array<Record<string, string>> };
  } catch (err) {
    result.errorText =
      err instanceof Error && err.name === "AbortError"
        ? "vPIC request timed out."
        : "vPIC request error.";
    result.flags.reasons.push("vpic-unavailable");
    return result;
  } finally {
    clearTimeout(timer);
  }

  const r = payload?.Results?.[0] ?? {};
  const errorCode = (r.ErrorCode ?? "").trim();
  const errorText = (r.ErrorText ?? "").trim();
  // vPIC returns "0" when a VIN decodes cleanly; multiple codes are comma-joined.
  const codes = errorCode.split(",").map((c) => c.trim());
  const clean = codes.length > 0 && codes.every((c) => c === "0" || c === "");

  const vehicleType = (r.VehicleType ?? "").trim() || undefined;
  const bodyClass = (r.BodyClass ?? "").trim() || undefined;
  const gvwr = (r.GVWR ?? "").trim() || undefined;
  const gvwrLbLower = parseGvwrLowerLb(gvwr);

  const flags: VinFlags = {
    invalid: !clean,
    unlikelyHvut: false,
    suspicious: false,
    reasons: [],
  };
  if (!clean) flags.reasons.push(`vpic-error:${errorCode || "unknown"}`);

  // (2) Unlikely-2290 detection (only meaningful when the VIN decoded).
  if (clean) {
    if (vehicleType && UNLIKELY_VEHICLE_TYPES.has(vehicleType.toUpperCase())) {
      flags.unlikelyHvut = true;
      flags.reasons.push(`unlikely-type:${vehicleType}`);
    }
    if (gvwrLbLower != null && gvwrLbLower < threshold) {
      flags.unlikelyHvut = true;
      flags.reasons.push(`low-gvwr:${gvwrLbLower}lb<${threshold}lb`);
    }
  }
  flags.suspicious = flags.invalid || flags.unlikelyHvut;

  return {
    vin: cleaned,
    valid: clean,
    errorCode,
    errorText,
    // (3) make / model (+ year, type, body class)
    make: r.Make || undefined,
    model: r.Model || undefined,
    modelYear: r.ModelYear || undefined,
    vehicleType,
    bodyClass,
    gvwr,
    gvwrLbLower,
    flags,
    raw: r,
  };
}

/** Verify many VINs with bounded concurrency. Order of results matches input. */
export async function verifyVins(
  vins: string[],
  opts: VerifyVinOptions & { concurrency?: number } = {},
): Promise<VinResult[]> {
  const { concurrency = 4, ...rest } = opts;
  const results: VinResult[] = new Array(vins.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < vins.length) {
      const idx = next++;
      const v = vins[idx];
      if (v === undefined) continue;
      results[idx] = await verifyVin(v, rest);
    }
  }
  const workers = Math.max(1, Math.min(concurrency, vins.length || 1));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
