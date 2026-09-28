"""Capture browser_pool.py's argparse behavior over an argv corpus (run once with the reference venv's Python).

The parser below is copied verbatim from browser_pool.main, including `migrate`, which the port refuses as an
invalid choice (D15). It never imports browser_pool, so nothing touches the real registry.

    cd <temp dir> && HOME=<temp dir> ~/.config/opencode/mcp/fast-chrome/.native-venv/bin/python -B \
        <repo>/tests/server/pool/fixtures/capture-argparse.py > <repo>/tests/server/pool/fixtures/python-argparse.json
"""
import argparse
import contextlib
import io
import json
import re
import sys


class Gate(Exception):
    pass


def controller_number(controller):
    match = isinstance(controller, str) and re.fullmatch(r"isolated-([1-9]\d?)", controller)
    if not match or int(match[1]) > 8:
        raise Gate("browser-controller-unknown")
    return int(match[1])


def controller_argument(value):
    try:
        controller_number(value)
    except Gate:
        raise argparse.ArgumentTypeError("expected isolated-1 to isolated-8") from None
    return value


def parser():
    parser = argparse.ArgumentParser(prog="browser_pool.py")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status")
    claim_parser = commands.add_parser("claim", help="Claim an exclusive lease without starting Chrome")
    claim_parser.add_argument("controller", nargs="?", type=controller_argument)
    claim_parser.add_argument("--owner", required=True)
    ensure = commands.add_parser("ensure", help="Claim a lease and ensure its exact Chrome profile is ready")
    ensure.add_argument("controller", nargs="?", type=controller_argument)
    ensure.add_argument("--owner", required=True)
    ensure.add_argument("--timeout", type=float, default=30)
    ensure.add_argument("--site", help="URL or host whose cookie site the lease should hold")
    mode = ensure.add_mutually_exclusive_group()
    mode.add_argument("--exclusive", dest="exclusive", action="store_true", default=True,
                      help="No other tenant (default)")
    mode.add_argument("--shared", dest="exclusive", action="store_false",
                      help="Share the controller with tenants on other sites")
    release_parser = commands.add_parser("release")
    release_parser.add_argument("--owner", required=True)
    release_parser.add_argument("--lease", required=True)
    reap_parser = commands.add_parser("reap", help="Stop the Chrome of verified idle controllers")
    reap_parser.add_argument("controller", nargs="?", type=controller_argument)
    reap_parser.add_argument("--dry-run", action="store_true")
    reset_parser = commands.add_parser("reset", help="Delete and re-provision an idle, stopped profile")
    reset_parser.add_argument("controller", type=controller_argument)
    reset_parser.add_argument("--confirm", action="store_true")
    commands.add_parser("migrate", help="Point stopped profiles at their generated host wrappers")
    return parser


CORPUS = [
    [], ["status"], ["status", "extra"], ["status", "--owner", "x"], ["unknown"], ["migrate"],
    ["claim", "--owner", "ses_a"], ["claim", "isolated-2", "--owner", "ses_a"], ["claim", "--owner", "ses_a", "isolated-2"],
    ["claim", "--owner=ses_a"], ["claim", "--own", "ses_a"], ["claim", "--o", "ses_a"], ["claim"], ["claim", "--owner"],
    ["claim", "--owner", "--x"], ["claim", "--owner", "-1"], ["claim", "--owner", "-x"], ["claim", "isolated-9", "--owner", "ses_a"],
    ["claim", "isolated-0", "--owner", "ses_a"], ["claim", "isolated-1", "isolated-2", "--owner", "ses_a"],
    ["claim", "--owner", "ses_a", "--owner", "ses_b"], ["claim", "--owner", ""], ["claim", "--owner=", "isolated-3"],
    ["claim", "--", "isolated-1", "--owner", "ses_a"], ["claim", "--owner", "ses_a", "--", "isolated-1"],
    ["claim", "--bogus", "--owner", "ses_a"], ["claim", "-o", "ses_a"],
    ["ensure", "--owner", "ses_a"], ["ensure", "--owner", "ses_a", "--shared"], ["ensure", "--owner", "ses_a", "--exclusive"],
    ["ensure", "--owner", "ses_a", "--shared", "--exclusive"], ["ensure", "--owner", "ses_a", "--shared", "--shared"],
    ["ensure", "--owner", "ses_a", "--timeout", "0"], ["ensure", "--owner", "ses_a", "--timeout", "-1"],
    ["ensure", "--owner", "ses_a", "--timeout", "1.5"], ["ensure", "--owner", "ses_a", "--timeout", " 7 "],
    ["ensure", "--owner", "ses_a", "--timeout", "1_0"], ["ensure", "--owner", "ses_a", "--timeout", "nan"],
    ["ensure", "--owner", "ses_a", "--timeout", "inf"], ["ensure", "--owner", "ses_a", "--timeout", "-inf"],
    ["ensure", "--owner", "ses_a", "--timeout", "Infinity"], ["ensure", "--owner", "ses_a", "--timeout", "1e2"],
    ["ensure", "--owner", "ses_a", "--timeout", ".5"], ["ensure", "--owner", "ses_a", "--timeout", "5."],
    ["ensure", "--owner", "ses_a", "--timeout", "abc"], ["ensure", "--owner", "ses_a", "--timeout", ""],
    ["ensure", "--owner", "ses_a", "--timeout=-2"], ["ensure", "--owner", "ses_a", "--timeout", "-.5"],
    ["ensure", "--owner", "ses_a", "--site", "https://example.com/"], ["ensure", "--owner", "ses_a", "--site=example.com"],
    ["ensure", "--owner", "ses_a", "--s", "x"], ["ensure", "--owner", "ses_a", "--sh"], ["ensure", "--owner", "ses_a", "--si", "x"],
    ["ensure", "--owner", "ses_a", "--ex"], ["ensure", "--owner", "ses_a", "--e"], ["ensure", "--owner", "ses_a", "--t", "3"],
    ["ensure", "isolated-4", "--owner", "ses_a", "--shared"], ["ensure", "--owner", "ses_a", "--shared=1"],
    ["ensure", "--owner", "ses_a", "--site", "-x"], ["ensure", "--owner", "ses_a", "--site", "-5"],
    ["release", "--owner", "ses_a", "--lease", "00000000-0000-0000-0000-000000000000"], ["release", "--owner", "ses_a"],
    ["release", "--lease", "x"], ["release"], ["release", "--owner", "a", "--lease", "b", "isolated-1"],
    ["release", "--o", "a", "--l", "b"],
    ["reap"], ["reap", "isolated-3"], ["reap", "--dry-run"], ["reap", "isolated-1", "--dry-run"], ["reap", "--dry"],
    ["reap", "--d"], ["reap", "--dry-run", "isolated-8"], ["reap", "isolated-9"], ["reap", "--dry-run=yes"],
    ["reset", "isolated-2"], ["reset", "isolated-2", "--confirm"], ["reset"], ["reset", "--confirm"],
    ["reset", "--confirm", "isolated-1"], ["reset", "isolated-1", "isolated-2"], ["reset", "--conf", "isolated-1"],
    ["-h"], ["status", "-h"], ["claim", "--help"], ["--help"], ["--version"], ["-x"], ["--", "status"],
    ["ensure", "--owner", "ses_a", "--exclusive", "--shared"], ["ensure", "--shared", "--owner", "ses_a", "--ex"],
    ["reset", "--h"], ["--h"], ["--he"], ["claim", "--owner", "a b"], ["claim", "--owner x"], ["ensure", "--owner", "s", "--s=x"],
    ["claim", "--owner", "ses_a", "--", "--", "x"], ["claim", "--owner", "--", "ses_a"], ["ensure", "isolated-9", "--s", "x"],
    ["claim", "-", "--owner", "ses_a"], ["reap", "--dry-run", "--dry-run"], ["status", "--", "x"],
]


def run(argv):
    out, err = io.StringIO(), io.StringIO()
    code = 0
    namespace = None
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            namespace = vars(parser().parse_args(argv))
        except SystemExit as exit:
            code = exit.code if isinstance(exit.code, int) else 1
    if namespace is not None:
        namespace = {key: (value if not isinstance(value, float) or value == value and abs(value) != float("inf")
                           else repr(value)) for key, value in namespace.items()}
    lines = [line for line in err.getvalue().splitlines() if ": error: " in line]
    return {"argv": argv, "code": code, "namespace": namespace, "help": bool(out.getvalue()),
            "error": lines[-1].split(": error: ", 1)[1] if lines else None}


print(json.dumps({"python": sys.version.split()[0], "cases": [run(argv) for argv in CORPUS]}, indent=1))
