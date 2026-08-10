# Self-hosted web fonts

These Latin WOFF2 files preserve the site's existing typography while keeping
`next build` independent of Google Fonts availability. They are the exact
assets previously emitted by `next/font/google` and are now loaded with
`next/font/local` from `app/layout.tsx`.

| File | Family and range | SHA-256 |
| --- | --- | --- |
| `hanken-grotesk-latin.woff2` | Hanken Grotesk, normal 100–900 | `1F21C6EAA0000F3329CFCFAC966B43D5BEBF5AA610303E33294AC31BC6F4BB59` |
| `bricolage-grotesque-latin.woff2` | Bricolage Grotesque, normal 600–800 | `4FD48B2C1AB27220E71F15F990550261B35245C3BDFD8D8025B4BDAC0459EE2D` |
| `fraunces-latin-normal.woff2` | Fraunces, normal 400–700 | `88E17BE075F1BE50AB67B057B99E3701B828F44ED28F9452DF6C02645BB0CBA9` |
| `fraunces-latin-italic.woff2` | Fraunces, italic 400–700 | `C9745EE907C02CDD46CC41A65BB711CD861432F679A76C18E3DE204A18723040` |

Upstream families:

- <https://github.com/google/fonts/tree/main/ofl/hankengrotesk>
- <https://github.com/google/fonts/tree/main/ofl/bricolagegrotesque>
- <https://github.com/google/fonts/tree/main/ofl/fraunces>

All three families are distributed under the SIL Open Font License 1.1. The
copyright notices and license are included in `OFL.txt`.
