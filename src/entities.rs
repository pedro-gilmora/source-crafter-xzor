//! Decodes HTML character references (`&amp;`, `&eacute;`, `&#233;`, `&#xE9;`) in template text at
//! compile time, as Razor does. Named references are the HTML 4 set; unknown ones are kept as written.

use std::borrow::Cow;

/// `Latin-1` names for U+00A0..=U+00FF, in code point order.
const LATIN1: [&str; 96] = [
    "nbsp", "iexcl", "cent", "pound", "curren", "yen", "brvbar", "sect", "uml", "copy", "ordf", "laquo", "not", "shy", "reg", "macr",
    "deg", "plusmn", "sup2", "sup3", "acute", "micro", "para", "middot", "cedil", "sup1", "ordm", "raquo", "frac14", "frac12", "frac34", "iquest",
    "Agrave", "Aacute", "Acirc", "Atilde", "Auml", "Aring", "AElig", "Ccedil", "Egrave", "Eacute", "Ecirc", "Euml", "Igrave", "Iacute", "Icirc", "Iuml",
    "ETH", "Ntilde", "Ograve", "Oacute", "Ocirc", "Otilde", "Ouml", "times", "Oslash", "Ugrave", "Uacute", "Ucirc", "Uuml", "Yacute", "THORN", "szlig",
    "agrave", "aacute", "acirc", "atilde", "auml", "aring", "aelig", "ccedil", "egrave", "eacute", "ecirc", "euml", "igrave", "iacute", "icirc", "iuml",
    "eth", "ntilde", "ograve", "oacute", "ocirc", "otilde", "ouml", "divide", "oslash", "ugrave", "uacute", "ucirc", "uuml", "yacute", "thorn", "yuml",
];

/// The rest of the HTML 4 set.
const OTHER: &[(&str, u32)] = &[
    ("quot", 34), ("amp", 38), ("apos", 39), ("lt", 60), ("gt", 62),
    ("OElig", 338), ("oelig", 339), ("Scaron", 352), ("scaron", 353), ("Yuml", 376), ("fnof", 402), ("circ", 710), ("tilde", 732),
    ("Alpha", 913), ("Beta", 914), ("Gamma", 915), ("Delta", 916), ("Epsilon", 917), ("Zeta", 918), ("Eta", 919), ("Theta", 920),
    ("Iota", 921), ("Kappa", 922), ("Lambda", 923), ("Mu", 924), ("Nu", 925), ("Xi", 926), ("Omicron", 927), ("Pi", 928), ("Rho", 929),
    ("Sigma", 931), ("Tau", 932), ("Upsilon", 933), ("Phi", 934), ("Chi", 935), ("Psi", 936), ("Omega", 937),
    ("alpha", 945), ("beta", 946), ("gamma", 947), ("delta", 948), ("epsilon", 949), ("zeta", 950), ("eta", 951), ("theta", 952),
    ("iota", 953), ("kappa", 954), ("lambda", 955), ("mu", 956), ("nu", 957), ("xi", 958), ("omicron", 959), ("pi", 960), ("rho", 961),
    ("sigmaf", 962), ("sigma", 963), ("tau", 964), ("upsilon", 965), ("phi", 966), ("chi", 967), ("psi", 968), ("omega", 969),
    ("thetasym", 977), ("upsih", 978), ("piv", 982),
    ("ensp", 8194), ("emsp", 8195), ("thinsp", 8201), ("zwnj", 8204), ("zwj", 8205), ("lrm", 8206), ("rlm", 8207),
    ("ndash", 8211), ("mdash", 8212), ("lsquo", 8216), ("rsquo", 8217), ("sbquo", 8218), ("ldquo", 8220), ("rdquo", 8221), ("bdquo", 8222),
    ("dagger", 8224), ("Dagger", 8225), ("bull", 8226), ("hellip", 8230), ("permil", 8240), ("prime", 8242), ("Prime", 8243),
    ("lsaquo", 8249), ("rsaquo", 8250), ("oline", 8254), ("frasl", 8260), ("euro", 8364), ("image", 8465), ("weierp", 8472),
    ("real", 8476), ("trade", 8482), ("alefsym", 8501),
    ("larr", 8592), ("uarr", 8593), ("rarr", 8594), ("darr", 8595), ("harr", 8596), ("crarr", 8629),
    ("lArr", 8656), ("uArr", 8657), ("rArr", 8658), ("dArr", 8659), ("hArr", 8660),
    ("forall", 8704), ("part", 8706), ("exist", 8707), ("empty", 8709), ("nabla", 8711), ("isin", 8712), ("notin", 8713), ("ni", 8715),
    ("prod", 8719), ("sum", 8721), ("minus", 8722), ("lowast", 8727), ("radic", 8730), ("prop", 8733), ("infin", 8734), ("ang", 8736),
    ("and", 8743), ("or", 8744), ("cap", 8745), ("cup", 8746), ("int", 8747), ("there4", 8756), ("sim", 8764), ("cong", 8773),
    ("asymp", 8776), ("ne", 8800), ("equiv", 8801), ("le", 8804), ("ge", 8805), ("sub", 8834), ("sup", 8835), ("nsub", 8836),
    ("sube", 8838), ("supe", 8839), ("oplus", 8853), ("otimes", 8855), ("perp", 8869), ("sdot", 8901),
    ("lceil", 8968), ("rceil", 8969), ("lfloor", 8970), ("rfloor", 8971), ("lang", 9001), ("rang", 9002),
    ("loz", 9674), ("spades", 9824), ("clubs", 9827), ("hearts", 9829), ("diams", 9830),
];

fn named(name: &str) -> Option<char> {
    if let Some(i) = LATIN1.iter().position(|&n| n == name) {
        return char::from_u32(0xA0 + i as u32);
    }
    OTHER.iter().find(|(n, _)| *n == name).and_then(|&(_, c)| char::from_u32(c))
}

/// `&#N;` / `&#xH;`: zero, surrogates and values past U+10FFFF become U+FFFD, as in browsers.
fn numeric(body: &str) -> Option<char> {
    let value = match body.strip_prefix(['x', 'X']) {
        Some(hex) if !hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit()) => u32::from_str_radix(hex, 16).unwrap_or(u32::MAX),
        None if !body.is_empty() && body.bytes().all(|b| b.is_ascii_digit()) => body.parse().unwrap_or(u32::MAX),
        _ => return None,
    };
    Some(if value == 0 { '\u{FFFD}' } else { char::from_u32(value).unwrap_or('\u{FFFD}') })
}

/// Replaces every complete character reference (`&...;`) in `text`; anything else stays as written.
pub fn decode(text: &str) -> Cow<'_, str> {
    if !text.contains('&') {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        // Names are at most 8 characters; the window also fits long (invalid) numeric references.
        let decoded = rest[1..].char_indices().take(32).find(|&(_, c)| c == ';').and_then(|(semi, _)| {
            let body = &rest[1..1 + semi];
            let c = match body.strip_prefix('#') {
                Some(num) => numeric(num),
                None => named(body),
            };
            c.map(|c| (c, 1 + semi + 1))
        });
        match decoded {
            Some((c, len)) => {
                out.push(c);
                rest = &rest[len..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::decode;

    #[test]
    fn decodes_named_and_numeric_references() {
        assert_eq!(decode("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;"), "a & b <c> \"d\" 'e'");
        assert_eq!(decode("caf&eacute; &Ntilde; &yuml; &nbsp;|&copy;"), "café Ñ ÿ \u{a0}|©");
        assert_eq!(decode("&mdash;&hellip;&rarr;&euro;&trade;&Omega;&le;"), "—…→€™Ω≤");
        assert_eq!(decode("&#233;&#xE9;&#XE9;&#128512;"), "ééé😀");
    }

    #[test]
    fn keeps_what_is_not_a_complete_reference() {
        assert_eq!(decode("no entities"), "no entities");
        assert_eq!(decode("&unknown; &amp &; &#; &#xZZ; & alone"), "&unknown; &amp &; &#; &#xZZ; & alone");
        // One pass: an encoded entity stays an entity.
        assert_eq!(decode("&amp;amp;"), "&amp;");
    }

    #[test]
    fn invalid_code_points_become_the_replacement_character() {
        assert_eq!(decode("&#0;&#xD800;&#x110000;&#99999999999;"), "\u{FFFD}\u{FFFD}\u{FFFD}\u{FFFD}");
    }

    #[test]
    fn latin1_table_covers_a0_to_ff() {
        assert_eq!(decode("&nbsp;"), "\u{a0}");
        assert_eq!(decode("&times;&divide;"), "×÷");
        assert_eq!(decode("&yuml;"), "\u{ff}");
    }
}
