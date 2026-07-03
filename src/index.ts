/**
 * gideon-vin — verify and decode US vehicle VINs via the public NHTSA vPIC API,
 * for IRS Form 2290 (Heavy Highway Vehicle Use Tax) VIN detection.
 *
 * It does three things:
 *   1. Flags an invalid VIN (bad format, or vPIC can't decode it) — always.
 *   2. Rates how likely the vehicle is to be a Form 2290 vehicle:
 *        • veryUnlikelyHvut (STRONG warning) — passenger cars, motorcycles,
 *          SUVs/MPVs, vans, pickups, trailers, and other clearly-not-2290
 *          vehicle types / body styles.
 *        • unlikelyHvut (warning) — GVWR class 1–6 (up to 26,000 lb).
 *        (class 7 and 8 / heavy trucks are treated as fine.)
 *   3. Returns the vehicle's make, model (and year, type, body class).
 *
 * It never hard-blocks — it only flags. Callers decide what to do.
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
 * vPIC `VehicleType` values that are never Form 2290 vehicles — a STRONG signal
 * regardless of weight. (Vans and pickups usually decode as "TRUCK"; they're
 * caught by the body-class and GVWR-class checks instead.)
 */
const VERY_UNLIKELY_TYPES = new Set([
  "PASSENGER CAR",
  "MULTIPURPOSE PASSENGER VEHICLE (MPV)",
  "MOTORCYCLE",
  "LOW SPEED VEHICLE (LSV)",
  "OFF ROAD VEHICLE",
  "TRAILER",
]);

/** Light-duty body styles (vPIC `BodyClass`) — a STRONG signal (cars, SUVs,
 *  vans, pickups) even when the vehicle type decodes as "TRUCK". */
const LIGHT_BODY_RE =
  /pickup|\bvan\b|minivan|sport utility|\bsuv\b|\bcuv\b|crossover|sedan|saloon|coupe|hatchback|wagon|convertible|roadster|\bmpv\b/i;

/** True when `vin` is 17 valid VIN characters (does not check the check digit). */
export function isValidVinFormat(vin: string): boolean {
  return VIN_RE.test(vin.trim().toUpperCase());
}

/** Parse the GVWR class number (1–8) from a vPIC GVWR string, e.g.
 *  "Class 7: 26,001 - 33,000 lb" → 7, "Class 2E: 6,001 - 7,000 lb" → 2. */
export function parseGvwrClass(gvwr: string | null | undefined): number | undefined {
  if (!gvwr) return undefined;
  const m = gvwr.match(/class\s+(\d+)/i);
  return m && m[1] ? Number(m[1]) : undefined;
}

/** Parse the lower-bound weight in pounds from a vPIC GVWR class string, e.g.
 *  "Class 8: 33,001 lb and above" → 33001, "Class 2E: 6,001 - 7,000 lb" → 6001. */
export function parseGvwrLowerLb(gvwr: string | null | undefined): number | undefined {
  if (!gvwr) return undefined;
  const afterLabel = gvwr.includes(":") ? gvwr.slice(gvwr.indexOf(":") + 1) : gvwr;
  const m = afterLabel.replace(/,/g, "").match(/\d{3,}/);
  return m ? Number(m[0]) : undefined;
}

export interface VinFlags {
  /** The VIN format is invalid, or vPIC could not decode it. Always evaluated. */
  invalid: boolean;
  /** STRONG warning: a vehicle type / body style that is never a Form 2290
   *  vehicle — passenger car, SUV/MPV, motorcycle, van, pickup, or trailer. */
  veryUnlikelyHvut: boolean;
  /** Warning: a GVWR class 1–6 vehicle (up to 26,000 lb) — too light for 2290. */
  unlikelyHvut: boolean;
  /** True if any flag above is set — surface a warning to the filer (never block). */
  suspicious: boolean;
  /** Machine-readable reasons, e.g. "invalid-format", "vpic-error:1",
   *  "very-unlikely-type:PASSENGER CAR", "very-unlikely-body:Pickup",
   *  "gvwr-class-1-6:3". */
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
  /** GVWR class number 1–8, parsed from `gvwr`. */
  gvwrClass?: number;
  /** Lower bound of the GVWR range in pounds, parsed from `gvwr`. */
  gvwrLbLower?: number;
  flags: VinFlags;
  /** The full vPIC `Results[0]` object. */
  raw: Record<string, string>;
}

export interface VerifyVinOptions {
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
    flags: {
      invalid: true,
      veryUnlikelyHvut: false,
      unlikelyHvut: false,
      suspicious: true,
      reasons: [],
    },
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
  const gvwrClass = parseGvwrClass(gvwr);
  const gvwrLbLower = parseGvwrLowerLb(gvwr);

  const flags: VinFlags = {
    invalid: !clean,
    veryUnlikelyHvut: false,
    unlikelyHvut: false,
    suspicious: false,
    reasons: [],
  };
  if (!clean) flags.reasons.push(`vpic-error:${errorCode || "unknown"}`);

  // (2) Likelihood rating — only meaningful when the VIN decoded.
  if (clean) {
    const reasons: string[] = [];
    // STRONG: vehicle types / body styles that are never 2290 vehicles.
    let strong = false;
    if (vehicleType && VERY_UNLIKELY_TYPES.has(vehicleType.toUpperCase())) {
      strong = true;
      reasons.push(`very-unlikely-type:${vehicleType}`);
    }
    if (bodyClass && LIGHT_BODY_RE.test(bodyClass)) {
      strong = true;
      reasons.push(`very-unlikely-body:${bodyClass}`);
    }
    // Warn on GVWR class 1–6 (up to 26,000 lb). Class 7 and 8 are fine.
    const cls =
      gvwrClass ?? (gvwrLbLower != null && gvwrLbLower <= 26_000 ? 6 : undefined);
    const classIs1to6 = cls != null && cls <= 6;
    if (classIs1to6) {
      reasons.push(`gvwr-class-1-6:${gvwrClass ?? `~${gvwrLbLower}lb`}`);
    }

    flags.veryUnlikelyHvut = strong;
    flags.unlikelyHvut = !strong && classIs1to6;
    flags.reasons.push(...reasons);
  }

  flags.suspicious = flags.invalid || flags.veryUnlikelyHvut || flags.unlikelyHvut;

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
    gvwrClass,
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
