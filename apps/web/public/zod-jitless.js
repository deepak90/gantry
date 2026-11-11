// The app runs under a Content-Security-Policy without 'unsafe-eval' (vercel.json). zod 4 compiles its object schemas
// with `new Function` when it may, and finds out by trying `Function('')`, which the policy refuses and reports. Told
// to stay jitless it never tries, and checks the same things as plain code. zod reads this setting when it loads, and
// a schema can be read while the app's bundles are still loading, so it is set here, before any of them runs.
globalThis.__zod_globalConfig = Object.assign(globalThis.__zod_globalConfig || {}, { jitless: true });
