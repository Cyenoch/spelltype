# Third-party licenses and notices

Spelltype includes or depends on third-party work. Each component remains subject to its own license, copyright notices, and attribution requirements. The root Apache License 2.0 with Commons Clause 1.0 applies only to the project licensors' own rights; it does not replace these licenses or restrict rights independently granted by them.

## Vendored agent skills

The source repositories and skill paths are recorded in `skills-lock.json`. The copies under `.agents/skills/` are third-party material, not newly authored Spelltype code.

See [the complete Skills index](licenses/skills/INDEX.md) for the mapping of local skills to source repositories and preserved license / notice files. Keep the relevant originals with any redistributed skill copies. A lockfile hash or a license identifier alone is not a substitute for the required text.

## Application dependencies and development tools

npm dependencies and development tools retain the licenses and notices supplied in their package distributions. This repository does not duplicate a license file for every installed package or maintain a separate package-by-package license inventory.

If dependency code is included in a distributed browser bundle, Worker artifact, or other release, preserve the notices required for the components actually shipped. This requirement is separate from merely referencing dependencies in `package.json`.

## Generated Cloudflare runtime declarations

`worker-configuration.d.ts` identifies its generator as Wrangler and its runtime as `workerd@1.20260916.1`. Its runtime declaration section already carries these notices, which remain intact:

> Copyright (c) Cloudflare. All rights reserved.
>
> Copyright (c) Microsoft Corporation. All rights reserved.

That section is licensed under unmodified Apache License 2.0, without the project's Commons Clause. See [the generated-type notice](licenses/dependencies/INDEX.md) for the full license.

## Artwork

`public/assets/provenance.json` records the shipped artwork's origin and derivation. It describes generated bitmaps, local derivatives, and hand-authored SVGs; it does not identify third-party stock-art licenses to reproduce here. This is provenance information, not an assertion that AI outputs have exclusive copyright or that unknown provider terms have been verified.

See [LICENSING.md](LICENSING.md) for the limited application of the project's license to rights it actually holds in those assets.
