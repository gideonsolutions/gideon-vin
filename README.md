# gideon-vin

Verify and decode US vehicle VINs via the public [NHTSA vPIC API](https://vpic.nhtsa.dot.gov/api/), for IRS **Form 2290** (Heavy Highway Vehicle Use Tax) VIN detection.

Zero dependencies. Uses the global `fetch` (Node 18+, browsers, edge runtimes). It **only flags — it never hard-blocks.**

It does three things:

1. **Flags invalid VINs** (bad format, or vPIC can't decode) — always.
2. **Rates how likely the vehicle is to be a Form 2290 vehicle:**
   - **`veryUnlikelyHvut`** (strong warning) — passenger cars, motorcycles, SUVs/MPVs, vans, pickups, trailers, and other clearly-not-2290 vehicle types/body styles.
   - **`unlikelyHvut`** (warning) — **GVWR class 1–6** (up to 26,000 lb). (Class 7 and 8 / heavy trucks are treated as fine.)
3. **Returns make and model** (plus year, type, body class).

## Install

```sh
npm install gideonsolutions/gideon-vin
```

## Usage

```ts
import { verifyVin } from "gideon-vin";

const res = await verifyVin("1FUJA6CK77LY00000");

res.valid;                // vPIC decoded the VIN cleanly (ErrorCode "0")
res.make;                 // "FREIGHTLINER"
res.model;                // "Cascadia"
res.vehicleType;          // "TRUCK"
res.gvwrClass;            // 8
res.flags.invalid;        // bad format, or vPIC couldn't decode it
res.flags.veryUnlikelyHvut; // STRONG: car/SUV/moto/van/pickup/trailer type or body
res.flags.unlikelyHvut;   // warn: GVWR class 1–6
res.flags.suspicious;     // invalid || veryUnlikelyHvut || unlikelyHvut
res.flags.reasons;        // ["very-unlikely-type:PASSENGER CAR", "gvwr-class-1-6:3"]
```

`verifyVin` never throws on network/HTTP errors — it returns a result with
`flags.invalid = true` and a reason, so you can show a soft warning without
breaking a filing flow.

### How the rating is decided

A vehicle is flagged **`veryUnlikelyHvut`** (show a strong warning) when the
decoded **vehicle type** is a passenger car, MPV/SUV, motorcycle, low-speed
vehicle, or trailer, or the **body class** is a light-duty style (pickup, van,
SUV, sedan, coupe, hatchback, wagon, …).

It's flagged **`unlikelyHvut`** (warning) when the **GVWR class is 1–6** (up to
26,000 lb). Class 7 (26,001–33,000 lb), class 8, and heavy truck-tractors pass
clean.

Whatever the flags, `verifyVin` never blocks — the caller decides.

### Bulk

```ts
import { verifyVins } from "gideon-vin";
const results = await verifyVins(vins, { concurrency: 4 });
```

### Helpers

```ts
import { isValidVinFormat, parseGvwrClass, parseGvwrLowerLb } from "gideon-vin";
isValidVinFormat("1FUJA6CK77LY00000");           // true
parseGvwrClass("Class 7: 26,001 - 33,000 lb");   // 7
parseGvwrLowerLb("Class 8: 33,001 lb and above"); // 33001
```

## License

Released by **Gideon Solutions, LLC** under the **Gideon Christian Open Source
License (GCOSL), Version 1.0** — see [LICENSE.md](./LICENSE.md). Both
non‑commercial and commercial use are welcome, subject to the license terms.
