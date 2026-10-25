; The HTML grammar's nodes; xzor's own syntax comes from the language server's semantic tokens.
(tag_name) @tag

(attribute_name) @attribute

[
  "\""
  "'"
  (attribute_value)
] @string

(comment) @comment

(entity) @string.special

"=" @punctuation.delimiter

[
  "<"
  ">"
  "</"
  "/>"
] @punctuation.bracket
