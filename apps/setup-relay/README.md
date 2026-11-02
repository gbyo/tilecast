# Tilecast setup relay

The setup relay lets a phone give a new screen its Tilecast Server address. It
is a Cloudflare Worker with one Durable Object class and a static setup page.
The relay carries one encrypted envelope from Studio to a waiting Player. It
cannot read the envelope.

[`docs/phone-setup.md`](../../docs/phone-setup.md) is the contract: the QR
code, the envelope, the relay API, and the Player and Studio requirements.

This package is not an npm workspace. It has its own lockfile, so the Workers
toolchain does not enter the root install.

```sh
npm ci
npm run build     # assembles the setup page in build/
npm run typecheck
npm test          # runs in the Workers runtime through Miniflare
npm run check     # builds the Worker without a deploy
npm run dev       # serves the relay and the setup page on localhost:8787
npm run deploy    # needs a Wrangler sign-in to the account that owns the domain
```

After a change to `wrangler.jsonc`, run
`npx wrangler types --include-runtime=false` and commit
`worker-configuration.d.ts`.

The setup page copies the look of the Studio sign-in page. The build takes the
logo from Studio's `TilecastLogo` component and the Geist font from npm.
`public/setup.css` repeats the Studio theme values; update it when
`apps/dashboard/src/styles.css` changes them.
