# Security

MIRAGE runs untrusted x86 code: a program it runs must not reach the host. In the browser it is in
the page's sandbox and makes no request but those its pages make (the OASIS relay fetches only from
the hosts `src/oasis-hosts.js` names); in Node, MIRAGE-LINUX's file system reads only the directory
it was given.

If you find a way out — a guest that reads or writes outside what MIRAGE gives it, a request the
relay should not make — please report it privately through GitHub's
[security advisories](https://github.com/jfrelat-lab/mirage-x86/security/advisories/new) rather than
an issue.
