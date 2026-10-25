// The bundled client's warning that a controller's certificate is not checked,
// with the RAPID Live setting that turns the check on. No `vscode`.
//
// With abbRobot.strictTls off (the default) the client logs once per controller and
// port, at warn level, that it talks https to it without checking its certificate.
// The line names the client's own options (`strictTls: true`, `rejectUnauthorized:
// true`), which a RAPID Live user does not set: RAPID Live passes abbRobot.strictTls
// to the client as `strictTls`, and a change applies after a window reload. The
// logger RAPID Live installs in the client (extension.ts, activate) adds the setting
// to that line.

/** How the client's line begins (abb-rws-client 1.5.1, `warnUnverifiedTls`). */
const UNVERIFIED_TLS = /^TLS: the certificate of https:\/\/\S+ is not checked \(strictTls is off\)/;

/** The sentence added to the client's line. */
export const STRICT_TLS_HINT = 'In RAPID Live: turn on the abbRobot.strictTls setting, then reload the window.';

/** `msg` with RAPID Live's setting added when it is the client's unchecked-certificate line; any other message as it is. */
export function withStrictTlsHint(msg: string): string {
  return UNVERIFIED_TLS.test(msg) ? `${msg} ${STRICT_TLS_HINT}` : msg;
}
