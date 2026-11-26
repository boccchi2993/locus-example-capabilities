# ============================================================
#  locus_capability_sdk._descriptors — the runtime descriptor
#  validators, ported from locus-harness src/extension-composition.js
#  (as re-exported to the product through src/product/harness-api.js).
#
#  The NORMALIZED outputs are load-bearing beyond validation: they are
#  embedded in the bundle lock and the LOCUS.md manifest, so every
#  default (displayName -> id, description -> "", header lowercased,
#  scheme -> null when absent, empty credentials dropped from the
#  lock) must match the JS byte for byte. The cross-check pins this.
#
#  Error text may differ from JS; the diagnostic code that carries it
#  is uniformly "package_descriptor_invalid" (capability-package.js
#  normalizeDescriptor), so cross-checking compares codes, not text.
# ============================================================

import re

EXTENSION_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
EXTENSION_PY_MODULE_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$")

PLUGIN_RUNTIMES = ("python", "javascript", "wasm")
PLUGIN_V1_AUTHORITY = "none"
SKILL_DEFINITION_FORBIDDEN_FIELDS = ("body", "content", "markdown", "inlineSource", "path")

CREDENTIAL_NAME_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]{1,63}$")
CREDENTIAL_HEADER_PATTERN = re.compile(r"^[A-Za-z0-9-]+$")
CREDENTIAL_FORBIDDEN_HOST_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".home.arpa")
CREDENTIAL_FIELDS = ("name", "label", "description", "origin", "pathPrefix", "header", "scheme")

SKILL_INSTANCE_MAX_BYTES = 256 * 1024  # skills are Markdown text, never binary


class ExtensionDescriptorError(Exception):
    """Mirrors the harness extensionDescriptorError (code extension_descriptor_invalid)."""


def _require_string(value, field, descriptor_id):
    if not isinstance(value, str) or not value.strip():
        raise ExtensionDescriptorError(
            "%s: \"%s\" must be a non-empty string" % (descriptor_id, field))
    return value


def _require_id(value, kind):
    if not isinstance(value, str) or not EXTENSION_ID_PATTERN.fullmatch(value):
        raise ExtensionDescriptorError(
            "%s id must match %s: %s" % (kind, EXTENSION_ID_PATTERN.pattern, _js_str(value)))
    return value


def _js_str(value):
    import json
    return json.dumps(value, ensure_ascii=True)


def _normalize_string_list(value, field, descriptor_id):
    if value is None:
        return []
    if not isinstance(value, list):
        raise ExtensionDescriptorError(
            "%s: \"%s\" must be an array of ids" % (descriptor_id, field))
    out = []
    for v in value:
        if not isinstance(v, str) or not EXTENSION_ID_PATTERN.fullmatch(v):
            raise ExtensionDescriptorError(
                "%s: \"%s\" entries must be valid ids, got %s" % (descriptor_id, field, _js_str(v)))
        if v not in out:
            out.append(v)  # duplicate refs normalize/dedupe
    return out


def _is_plain_object(value):
    return isinstance(value, dict)


def validate_plugin_descriptor(raw):
    if not _is_plain_object(raw):
        raise ExtensionDescriptorError("plugin descriptor must be an object")
    pid = _require_id(raw.get("id"), "plugin")
    _require_string(raw.get("version"), "version", "plugin " + pid)
    if raw.get("runtime") not in PLUGIN_RUNTIMES:
        raise ExtensionDescriptorError(
            "plugin %s: unsupported runtime %s (supported: %s)"
            % (pid, _js_str(raw.get("runtime")), ", ".join(PLUGIN_RUNTIMES)))
    if raw.get("authority") != PLUGIN_V1_AUTHORITY:
        raise ExtensionDescriptorError(
            "plugin %s: v1 plugin authority must be \"none\", got %s"
            % (pid, _js_str(None if raw.get("authority") is None else raw.get("authority"))))
    provides = raw.get("provides")
    if provides is None:
        provides = {}
    if not isinstance(provides, dict):
        raise ExtensionDescriptorError(
            "plugin %s: \"provides\" must be an object of string arrays" % pid)
    provides_out = {}
    for key in provides.keys():
        lst = provides[key]
        if not isinstance(lst, list) or any(not isinstance(v, str) or not v for v in lst):
            raise ExtensionDescriptorError(
                "plugin %s: provides.%s must be an array of non-empty strings" % (pid, key))
        provides_out[key] = list(lst)
    if raw.get("runtime") == "python":
        if not isinstance(provides_out.get("pythonImports"), list):
            raise ExtensionDescriptorError(
                "plugin %s: python plugins must declare provides.pythonImports "
                "(array of module names)" % pid)
        for name in provides_out["pythonImports"]:
            if not EXTENSION_PY_MODULE_PATTERN.fullmatch(name):
                raise ExtensionDescriptorError(
                    "plugin %s: invalid python module name in provides.pythonImports: %s"
                    % (pid, name))
    display_name = raw.get("displayName")
    return {
        "kind": "plugin",
        "id": pid,
        "version": raw.get("version"),
        "displayName": display_name if (
            isinstance(display_name, str) and display_name.strip()) else pid,
        "description": raw.get("description") if isinstance(raw.get("description"), str) else "",
        "runtime": raw.get("runtime"),
        "authority": PLUGIN_V1_AUTHORITY,
        "provides": provides_out,
    }


def validate_skill_descriptor(raw):
    if not _is_plain_object(raw):
        raise ExtensionDescriptorError("skill descriptor must be an object")
    sid = _require_id(raw.get("id"), "skill")
    _require_string(raw.get("version"), "version", "skill " + sid)
    description = _require_string(raw.get("description"), "description", "skill " + sid)
    for field in SKILL_DEFINITION_FORBIDDEN_FIELDS:
        if field in raw:
            raise ExtensionDescriptorError(
                "skill %s: \"%s\" is not allowed on a SkillDefinition"
                % (sid, field))
    display_name = raw.get("displayName")
    return {
        "kind": "skill",
        "id": sid,
        "version": raw.get("version"),
        "displayName": display_name if (
            isinstance(display_name, str) and display_name.strip()) else sid,
        "description": description,
    }


def validate_mcp_descriptor(raw):
    if not _is_plain_object(raw):
        raise ExtensionDescriptorError("mcp descriptor must be an object")
    mid = _require_id(raw.get("id"), "mcp")
    display_name = raw.get("displayName")
    descriptor = {
        "kind": "mcp",
        "id": mid,
        "displayName": display_name if (
            isinstance(display_name, str) and display_name.strip()) else mid,
        "description": raw.get("description") if isinstance(raw.get("description"), str) else "",
    }
    # C3 phase-2 §3.2: the endpoint trio is appended LAST and only when
    # declared — a legacy descriptor normalizes to exactly the four
    # baseline keys so old package locks stay byte-identical (§3.5).
    endpoint = validate_mcp_endpoint_fields(raw, mid)
    if endpoint is not None:
        descriptor["url"] = endpoint["url"]
        descriptor["auth"] = endpoint["auth"]
        descriptor["credential"] = endpoint["credential"]
    return descriptor


# C3 phase-2 §3.2 — the three OPTIONAL endpoint fields (url / auth /
# credential), all-or-nothing. Returns {url, auth, credential} when
# declared, None for a legacy entry. Verdict-equivalent to the harness
# validateMcpDescriptor (message text may differ; codes do not).
MCP_URL_MAX_LENGTH = 2048


def _mcp_url_reject_reason(raw):
    """C3 phase-2 §3.2 url rules; a reject reason string or None.

    Verdict-equivalent to the WHATWG-based JS check: https, no userinfo /
    query / fragment, canonical spelling (new URL(raw).href === raw),
    public-DNS host, and a pathname that starts with "/" and contains
    none of "..", "//", "%".
    """
    from urllib.parse import urlsplit
    if not isinstance(raw, str) or not raw:
        return "url must be a non-empty string"
    if len(raw) > MCP_URL_MAX_LENGTH:
        return "url is over the %d-character limit" % MCP_URL_MAX_LENGTH
    try:
        parts = urlsplit(raw)
    except ValueError:
        return "url must be an https URL without userinfo, query or fragment"
    if parts.scheme != "https":
        return "url must be an https URL without userinfo, query or fragment"
    if "@" in parts.netloc or parts.query or parts.fragment:
        return "url must be an https URL without userinfo, query or fragment"
    # Host / port extraction (WHATWG shape, mirrors _origin_round_trip).
    host = parts.netloc
    port = None
    if host.startswith("["):
        end = host.find("]")
        if end < 0:
            return "url must be written in its canonical form"
        port_part = host[end + 1:]
        host = host[:end + 1]
        if port_part.startswith(":"):
            port = port_part[1:]
        elif port_part:
            return "url must be written in its canonical form"
    elif ":" in host:
        host, _, port = host.partition(":")
        if ":" in host:
            return "url must be written in its canonical form"
    if not host:
        return "url must be an https URL without userinfo, query or fragment"
    if not host.startswith("["):
        # WHATWG forbidden host code points fail parsing outright.
        forbidden = any(c in host for c in (
            "\t", "\n", "\r", " ", "#", "%", "/", ":", "<", ">", "?", "@",
            "[", "\\", "]", "^", "|")) or any(ord(c) < 0x20 or ord(c) == 0x7F for c in host)
        if forbidden:
            return "url must be an https URL without userinfo, query or fragment"
        if host != host.lower():
            return "url must be written in its canonical form"
    if port is not None:
        if not port.isdigit() or port == "":
            return "url must be an https URL without userinfo, query or fragment"
        if int(port) == 443 or str(int(port)) != port:
            return "url must be written in its canonical form (no default port, no leading zeros)"
    path = parts.path
    # WHATWG normalizes dot segments and percent-encodes everything
    # outside the RFC 3986 path set — any such spelling cannot be
    # canonical. Backslashes become "/" in special schemes.
    if not path or not path.startswith("/"):
        return "url must be written in its canonical form (non-empty path)"
    if "\\" in path:
        return "url must be written in its canonical form"
    # RFC 3986 pchar + "/" minus "%": anything else (space, control,
    # non-ASCII, `"<>^\`|{}` …) is percent-encoded by WHATWG href.
    PATH_ALLOWED = set(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
        "-._~!$&'()*+,;=:@/")
    if any(c not in PATH_ALLOWED and c != "%" for c in path):
        return "url must be written in its canonical form"
    if "%" in path:
        # A valid %XX survives WHATWG href verbatim; an invalid one is
        # re-encoded (and can no longer be canonical).
        for i, c in enumerate(path):
            if c == "%" and not (i + 2 < len(path)
                                 and path[i + 1] in "0123456789abcdefABCDEF"
                                 and path[i + 2] in "0123456789abcdefABCDEF"):
                return "url must be written in its canonical form"
    segments = path.split("/")
    if any(seg in (".", "..") for seg in segments):
        return "url must be written in its canonical form (no dot segments)"
    host_out = host if host.startswith("[") else host.lower()
    href = "https://" + host_out + ((":" + port) if port else "") + path
    if href != raw:
        return "url must be written in its canonical form (new URL(raw).href === raw)"
    # Public-DNS host judgment — the SAME rule the credential origin uses.
    host_rule = host_out[1:-1] if host_out.startswith("[") else host_out
    if not _host_is_public_dns_name(host_rule):
        return "url host %s is not a public DNS name (MCP servers are reached only at public hosts)" \
            % _js_str(host_rule)
    if ".." in path or "//" in path or "%" in path:
        return "url pathname must start with \"/\" and contain none of \"..\", \"//\", \"%\""
    return None


def _host_is_public_dns_name(host):
    is_ipv4 = re.fullmatch(r"[0-9.]+", host) is not None and "." in host
    is_ipv6 = host.startswith("[") or ":" in host
    forbidden_suffix = any(host.endswith(s) for s in CREDENTIAL_FORBIDDEN_HOST_SUFFIXES)
    return not (is_ipv4 or is_ipv6 or host == "localhost" or host.endswith(".")
                or forbidden_suffix or "." not in host)


def validate_mcp_endpoint_fields(raw, mid):
    at = "mcp " + mid
    present = [f for f in ("url", "auth", "credential") if f in raw]
    if not present:
        return None
    if len(present) < 3:
        missing = [f for f in ("url", "auth", "credential") if f not in present]
        raise ExtensionDescriptorError(
            '%s: "url", "auth" and "credential" are declared together (all three make the '
            'server connectable, none keeps it a legacy entry); missing: %s'
            % (at, ", ".join('"%s"' % f for f in missing)))
    auth = raw.get("auth")
    if auth != "bearer":
        raise ExtensionDescriptorError(
            '%s: "auth" must be "bearer" (this version supports bearer only), got %s'
            % (at, _js_str(None if auth is None else auth)))
    credential = raw.get("credential")
    if not isinstance(credential, str) or not CREDENTIAL_NAME_PATTERN.fullmatch(credential):
        raise ExtensionDescriptorError(
            '%s: "credential" must match %s, got %s'
            % (at, CREDENTIAL_NAME_PATTERN.pattern, _js_str(None if credential is None else credential)))
    reason = _mcp_url_reject_reason(raw.get("url"))
    if reason is not None:
        raise ExtensionDescriptorError('%s: %s' % (at, reason))
    return {"url": raw.get("url"), "auth": auth, "credential": credential}


def validate_mcp_binding(mcp, capability):
    """C3 phase-2 §3.3 — the binding rules between a connectable MCP
    descriptor and the capability that declares it.

    mcp/capability are VALIDATED descriptors. A legacy descriptor (no
    endpoint fields) returns None. Every other violation raises
    ExtensionDescriptorError with `mcp_binding_rule` naming the rule
    ('credential-reference' | 'bearer-scheme' | 'endpoint-coverage').
    """
    if not mcp or "url" not in mcp:
        return None
    cap = capability or {}
    mid = mcp["id"]
    credentials = cap.get("credentials") or []
    declared = None
    for c in credentials:
        if c and c.get("name") == mcp.get("credential"):
            declared = c
            break
    if declared is None:
        err = ExtensionDescriptorError(
            'mcp %s: credential "%s" is not declared by capability %s '
            "(a package server may only reference a credential of its own capability)"
            % (mid, mcp.get("credential"), cap.get("id")))
        err.mcp_binding_rule = "credential-reference"
        raise err
    if declared.get("header") != "authorization" or declared.get("scheme") != "Bearer":
        err = ExtensionDescriptorError(
            'mcp %s: credential "%s" must be a bearer binding (header "authorization", '
            'scheme "Bearer") to secure an MCP server, got header %s, scheme %s'
            % (mid, declared.get("name"), _js_str(declared.get("header")),
               _js_str(declared.get("scheme"))))
        err.mcp_binding_rule = "bearer-scheme"
        raise err
    from urllib.parse import urlsplit
    try:
        parsed = urlsplit(mcp["url"])
    except ValueError:
        parsed = None
    origin = None
    if parsed is not None and parsed.scheme == "https" and "@" not in parsed.netloc:
        host = parsed.netloc
        if ":" in host and not host.startswith("["):
            host = host.partition(":")[0]
        origin = parsed.scheme + "://" + host.lower()
    path_prefix = declared.get("pathPrefix")
    covered = (origin is not None and origin == declared.get("origin")
               and isinstance(path_prefix, str) and parsed.path.startswith(path_prefix))
    if not covered:
        err = ExtensionDescriptorError(
            'mcp %s: credential "%s" binding (origin %s, pathPrefix %s) does not cover the '
            "server url %s" % (mid, declared.get("name"), _js_str(declared.get("origin")),
                               _js_str(declared.get("pathPrefix")), _js_str(mcp["url"])))
        err.mcp_binding_rule = "endpoint-coverage"
        raise err
    return None


def _origin_round_trip(origin):
    """WHATWG `new URL(o)` + `url.origin === o` round-trip, https only.

    Returns (host, None) when origin is a canonical https origin string,
    or (None, reason) otherwise. Mirrors the harness check closely
    enough for the inputs descriptor authors can produce: canonical
    form is 'https://' + lowercased host + ':port' (only non-default),
    no path/query/fragment/userinfo.
    """
    from urllib.parse import urlsplit
    try:
        parts = urlsplit(origin)
    except ValueError:
        return None, "unparseable URL"
    if parts.scheme.lower() != "https":
        return None, "scheme must be https"
    netloc = parts.netloc
    if "@" in netloc:
        return None, "userinfo is not allowed"
    host = netloc
    port = None
    if host.startswith("["):
        end = host.find("]")
        if end < 0:
            return None, "unparseable host"
        port_part = host[end + 1:]
        host = host[:end + 1]
        if port_part.startswith(":"):
            port = port_part[1:]
        elif port_part:
            return None, "unparseable host"
    elif ":" in host:
        host, _, port = host.partition(":")
    if not host:
        return None, "empty host"
    host_lower = host.lower()
    if port is not None:
        if not port.isdigit():
            return None, "invalid port"
        if int(port) == 443:
            port = None  # WHATWG url.origin drops the default port
    canonical = "https://" + host_lower + ((":" + port) if port else "")
    if origin != canonical:
        return None, "origin must be exactly the canonical https origin (no path, " \
            "query, fragment or userinfo)"
    if parts.path or parts.query or parts.fragment:
        return None, "origin must not carry a path, query or fragment"
    return host_lower, None


def validate_credential_binding(raw, capability_id, index):
    at = "capability %s: credentials[%d]" % (capability_id, index)
    if not _is_plain_object(raw):
        raise ExtensionDescriptorError(at + " must be an object")
    for key in raw.keys():
        if key not in CREDENTIAL_FIELDS:
            raise ExtensionDescriptorError(
                at + ": unknown credential field \"%s\"" % key)
    name = raw.get("name")
    if not isinstance(name, str) or not CREDENTIAL_NAME_PATTERN.fullmatch(name):
        raise ExtensionDescriptorError(
            at + ": \"name\" must match %s, got %s"
            % (CREDENTIAL_NAME_PATTERN.pattern, _js_str(None if name is None else name)))
    label = raw.get("label")
    if not isinstance(label, str) or not label.strip():
        raise ExtensionDescriptorError(
            at + ": \"label\" must be a non-empty string, got %s"
            % _js_str(None if label is None else label))
    description = raw.get("description")
    if description is not None and not isinstance(description, str):
        raise ExtensionDescriptorError(
            at + ": \"description\" must be a string when present, got %s" % _js_str(description))
    origin = raw.get("origin")
    host, reason = _origin_round_trip(origin) if isinstance(origin, str) else (None, None)
    if host is None:
        raise ExtensionDescriptorError(
            at + ": \"origin\" must be an https origin string (no path, query, fragment "
            "or userinfo), got %s" % _js_str(None if origin is None else origin))
    is_ipv4 = re.fullmatch(r"[0-9.]+", host) is not None and "." in host
    is_ipv6 = host.startswith("[") or ":" in host
    forbidden_suffix = any(host.endswith(s) for s in CREDENTIAL_FORBIDDEN_HOST_SUFFIXES)
    if is_ipv4 or is_ipv6 or host == "localhost" or host.endswith(".") \
            or forbidden_suffix or "." not in host:
        raise ExtensionDescriptorError(
            at + ": \"origin\" host %s is not a public DNS name "
            "(credentials are sent only to public hosts)" % _js_str(host))
    path_prefix = raw.get("pathPrefix")
    if (not isinstance(path_prefix, str) or not path_prefix.startswith("/")
            or not path_prefix.endswith("/") or ".." in path_prefix or "//" in path_prefix
            or "%" in path_prefix or "?" in path_prefix or "#" in path_prefix):
        raise ExtensionDescriptorError(
            at + ": \"pathPrefix\" must start and end with \"/\" and contain none of "
            "\"..\", \"//\", \"%%\", \"?\", \"#\", got %s"
            % _js_str(None if path_prefix is None else path_prefix))
    header = raw.get("header")
    header_lower = header.lower() if isinstance(header, str) else None
    header_ok = (header_lower is not None and header_lower != ""
                 and (header_lower in ("authorization", "x-api-key")
                      or (header_lower.startswith("x-")
                          and CREDENTIAL_HEADER_PATTERN.fullmatch(header) is not None
                          and not header_lower.startswith("x-forwarded-")
                          and header_lower != "x-real-ip")))
    if not header_ok:
        raise ExtensionDescriptorError(
            at + ": \"header\" must be \"authorization\", \"x-api-key\" or a custom \"x-\" "
            "name of [A-Za-z0-9-] (never \"x-forwarded-*\" or \"x-real-ip\"), got %s"
            % _js_str(None if header is None else header))
    scheme = raw.get("scheme")
    if scheme is not None and scheme != "Bearer":
        raise ExtensionDescriptorError(
            at + ": \"scheme\" (when present) must be exactly \"Bearer\", got %s" % _js_str(scheme))
    return {
        "name": name,
        "label": label,
        "description": description if isinstance(description, str) else "",
        "origin": origin,
        "pathPrefix": path_prefix,
        "header": header_lower,
        "scheme": None if scheme is None else scheme,
    }


def validate_capability_descriptor(raw):
    if not _is_plain_object(raw):
        raise ExtensionDescriptorError("capability descriptor must be an object")
    cid = _require_id(raw.get("id"), "capability")
    _require_string(raw.get("version"), "version", "capability " + cid)
    display_name = _require_string(raw.get("displayName"), "displayName", "capability " + cid)
    description = _require_string(raw.get("description"), "description", "capability " + cid)
    credentials_raw = raw.get("credentials")
    if credentials_raw is None:
        credentials_raw = []
    if not isinstance(credentials_raw, list):
        raise ExtensionDescriptorError(
            "capability %s: \"credentials\" must be an array" % cid)
    credentials = []
    names = set()
    for i, item in enumerate(credentials_raw):
        credential = validate_credential_binding(item, cid, i)
        if credential["name"] in names:
            raise ExtensionDescriptorError(
                "capability %s: duplicate credential name \"%s\" in credentials[%d]"
                % (cid, credential["name"], i))
        names.add(credential["name"])
        credentials.append(credential)
    return {
        "kind": "capability",
        "id": cid,
        "version": raw.get("version"),
        "displayName": display_name,
        "description": description,
        "plugins": _normalize_string_list(raw.get("plugins"), "plugins", "capability " + cid),
        "skills": _normalize_string_list(raw.get("skills"), "skills", "capability " + cid),
        "mcps": _normalize_string_list(raw.get("mcps"), "mcps", "capability " + cid),
        "credentials": credentials,
    }
