# Contributing to RAPID Live (abb-rws-vscode)

Thanks for your interest. This project is Apache-2.0 licensed.

## Developer Certificate of Origin

Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/)
(DCO) 1.1. You certify the DCO by adding a `Signed-off-by` line to every commit:

```
Signed-off-by: Your Name <your.email@example.com>
```

`git commit -s` adds it for you. The name and email must be real and must match
the commit author.

By signing off you certify that you wrote the contribution or otherwise have the
right to submit it under Apache-2.0, and that you understand it is public and
will be redistributed.

## Licensing of contributions

Contributions are licensed under Apache-2.0 (section 5), including its patent
grant (section 3). No separate CLA is required.

## Do not submit ABB code

This project is an independent, clean-room implementation built from public
documentation and from observed behaviour of live controllers. Do **not** submit
code, documentation text, header files or data copied from ABB SDKs, ABB
documentation, RobotStudio, or any source whose license is incompatible with
Apache-2.0. Linking permissively licensed libraries is fine; copying is not.

## Safety

This software talks to industrial robot controllers, which move and can injure
people. Develop and test against a RobotStudio virtual controller before going
anywhere near real hardware, and never point tests at a production cell.

Note that a virtual controller does not enforce everything a real one does. An
observation on a VC is evidence about a VC; say so rather than presenting it as
a hardware guarantee.

## Before you open a pull request

- `npm run build` must succeed AND `npx tsc --noEmit` must be clean - esbuild does not typecheck.
- Every new behaviour gets a test; existing tests stay green.
- Protocol claims must cite evidence - the probe or controller and the date, and
  whether it was observed on a virtual controller (VC) or on real hardware.

## Reporting a security issue

Do not open a public issue. See [SECURITY.md](./SECURITY.md).

If a report concerns the behaviour of an ABB controller rather than this
software, it belongs with ABB's product security team, not here. Please allow
coordinated disclosure before publishing details.
