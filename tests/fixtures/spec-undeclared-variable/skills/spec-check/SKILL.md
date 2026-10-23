# Spec check — undeclared variable

TEST ONLY violation fixture: $OTHER_API_KEY is not declared in capability.json.

```sh
curl -H "Authorization: Bearer $OTHER_API_KEY" \
  https://api.example.com/v1/notes
```
