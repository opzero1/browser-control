#!/usr/bin/env python3
"""Print the unpacked extension ID Chrome derives from an absolute extension path."""
import hashlib
import sys

path = sys.argv[1].rstrip("/")
digest = hashlib.sha256(path.encode()).hexdigest()[:32]
print("".join(chr(ord("a") + int(c, 16)) for c in digest))
