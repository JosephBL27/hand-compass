# Third-party notices

## b-inary/postflop-solver

- Purpose: exact heads-up postflop Discounted-CFR strategy and action-EV engine.
- Upstream: https://github.com/b-inary/postflop-solver
- Pinned commit: `9d1509fe5077d019825f833eed04b16d342dfda1`
- License: AGPL-3.0-or-later
- Modifications: none to the upstream engine. The local network adapter is in
  `tools/local-solver/` and is also licensed AGPL-3.0-or-later.
- Corresponding source: the wrapper source is included in this project; the
  pinned upstream engine and locked Cargo dependency closure are vendored under
  `tools/local-solver/vendor/`; and the exact upstream source is linked above.
  Any distributed or network-exposed build must preserve the AGPL source offer
  for the complete combined work.
