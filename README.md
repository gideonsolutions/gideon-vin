# gideon-vin

Verify and decode US vehicle VINs via the public [NHTSA vPIC API](https://vpic.nhtsa.dot.gov/api/), with a heavy‑vehicle (HVUT / IRS **Form 2290**) "weight looks unusually low" flag.

Zero dependencies. Uses the global `fetch` (Node 18+, browsers, edge runtimes).

## Install

```sh
npm install gideonsolutions/gideon-vin
```

## Usage

It does three things for **Form 2290** VIN detection:

1. **Flags invalid VINs** (bad format, or vPIC can't decode) — always.
2. **Flags vehicles unlikely to be a 2290 vehicle** — passenger cars, SUVs/MPVs,
   motorcycles, light pickups/vans, trailers — by vehicle type, body class, and
   gross weight rating.
3. **Returns make and model** (plus year, type, body class).

```ts
import { verifyVin } from "gideon-vin";

const res = await verifyVin("1FUJA6CK77LY00000");

res.valid;             // true when vPIC decoded the VIN cleanly (ErrorCode "0")
res.make;              // e.g. "FREIGHTLINER"
res.model;             // e.g. "Cascadia"
res.vehicleType;       // e.g. "TRUCK"
res.gvwr;              // e.g. "Class 8: 33,001 lb and above (14,969 kg and above)"
res.gvwrLbLower;       // 33001
res.flags.invalid;     // bad format, or vPIC couldn't decode it
res.flags.unlikelyHvut;// not a likely Form 2290 vehicle (car/SUV/moto/light truck)
res.flags.suspicious;  // invalid || unlikelyHvut
res.flags.reasons;     // ["unlikely-type:PASSENGER CAR", "low-gvwr:5001lb<26000lb"]
```

`verifyVin` never throws on network/HTTP errors — it returns a result with
`flags.invalid = true` and a reason, so you can show a soft warning without
breaking a filing flow.

### How "unlikely to be a 2290 vehicle" is decided

A real Form 2290 truck is a heavy highway vehicle (Class 7–8). A result is
flagged `unlikelyHvut` when either:

- the decoded **vehicle type** is a passenger car, MPV/SUV, motorcycle, low-speed
  vehicle, or trailer; or
- the **GVWR** lower bound is below the threshold (default **26,000 lb**, the top
  of Class 6) — this catches light pickups and vans that decode as `TRUCK`.

Tune the weight threshold:

```ts
await verifyVin(vin, { lowWeightThresholdLb: 33000 });
```

### Bulk

```ts
import { verifyVins } from "gideon-vin";
const results = await verifyVins(vins, { concurrency: 4 });
```

### Helpers

```ts
import { isValidVinFormat, parseGvwrLowerLb } from "gideon-vin";
isValidVinFormat("1FUJA6CK77LY00000"); // true
parseGvwrLowerLb("Class 8: 33,001 lb and above"); // 33001
```

## License

Released by **Gideon Solutions, LLC** under the **Gideon Christian Open Source
License (GCOSL), Version 1.0** — see [LICENSE.md](./LICENSE.md). Both
non‑commercial and commercial use are welcome, subject to the license terms.
