# Trademarks and project names

## ABB's marks

ABB, IRC5, OmniCore, RobotWare, RobotStudio, RAPID, FlexPendant, GoFa and
Robot Web Services are trademarks or registered trademarks of ABB Ltd.

**This project is not affiliated with, endorsed by, sponsored by, or supported
by ABB Ltd.** It is an independent, clean-room implementation built from
publicly available documentation and from observed behaviour of controllers the
maintainer operates.

## Why ABB's marks appear here

They appear for one reason only: to describe accurately what this software is
compatible with. Software that speaks ABB Robot Web Services cannot be described
without naming the protocol, the controller families it targets (IRC5,
OmniCore), and the RobotWare versions it has been tested against.

Apache-2.0 section 6 grants no trademark rights, and this project claims none.

## Our position on the `abb-rws-*` naming

The packages in this family are named `abb-rws-client`, `abb-rws-vscode`,
`abb-rws-panel`, `abb-rws-daemon`, `abb-rws-ros2`, `abb-rws-conformance` and
`abb-rws-mcp`.

The name says what the software talks to, not who made it. `abb-rws-client` is a
client for ABB Robot Web Services in the same way that a PostgreSQL driver is
named for PostgreSQL: it is a statement of compatibility, and it is the only
honest way to make the software findable by the people it is for. A developer
searching for a way to reach an OmniCore controller is searching for "ABB" and
"RWS", because those are the names of the things they have in front of them.

We think this is nominative use. We could be wrong about where the line sits,
which is why the rest of this section exists.

**What this project will not do:**

- Use ABB's logo, wordmark, colours, product photography, or any part of ABB's
  visual identity.
- Describe itself as official, certified, approved, endorsed, or supported by
  ABB, or use phrasing that invites that reading.
- Apply to register `abb-rws-*` or any confusingly similar mark, anywhere.
- Sell, license, or offer paid support for this software under ABB's name.
- Use ABB's marks as anything other than a plain-text reference to ABB's own
  products.

**If ABB asks us to change the naming, we will.** No argument, no delay for
negotiation. In practice that means: new package names published within 30 days
of a written request, the old names marked deprecated with a pointer to the new
ones so existing users are not stranded, and repositories renamed with redirects
left in place. Reach the maintainer through the contact route below.

We would rather be told early and fix it cheaply than discover a problem once
other projects depend on these names.

## This project's own names

Apache-2.0 covers the code in this repository. It does not grant rights to the
project names either (section 6 again, which cuts both ways).

`abb-rws-client`, `abb-rws-vscode`, `abb-rws-panel`, `abb-rws-ros2`,
`abb-rws-daemon`, `abb-rws-conformance`, `abb-rws-mcp` and "RAPID Live" identify
projects maintained by Meraj Safari.

**You may** use these names to describe compatibility or origin - "a fork of
abb-rws-ros2", "compatible with abb-rws-client".

**You may not** publish a fork or derivative under the same or a confusingly
similar name, or imply that your version is the official project or endorsed by
its maintainer.

If you fork, rename your fork and keep the `NOTICE` file.

## Third-party marks

Other names may be trademarks of their respective owners and are used for
identification only.

## Contact

Questions about trademark use in this project: open an issue at
<https://github.com/ichbinmeraj/abb-rws-vscode>, or contact the maintainer
privately if the matter is better handled that way.
