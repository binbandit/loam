# Escaped delimiters

Literal \==not a highlight\== stays plain.

Literal \%%not a comment\%% stays visible.

A real ==highlight== after escapes still works, and \== then ==this one== too.

Code fences keep delimiters literal:

```text
==not a highlight== and %%not a comment%%
```

Inline `==also literal==` and `%%still literal%%` in code.
