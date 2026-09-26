## Summary

Describe the change and why it is needed.

## Security and permission impact

Describe any effect on:

- workspace containment;
- permission profiles or native approvals;
- terminal, Python, browser, or desktop execution;
- credentials or persisted settings;
- audit evidence or task state.

Write "None expected" if none apply.

## Validation

Exact tested commit:

~~~text
<commit SHA>
~~~

Environment:

~~~text
Windows:
Node.js:
pnpm:
~~~

Commands run:

~~~text
<commands and exit status>
~~~

## Checklist

- [ ] The change is narrowly scoped.
- [ ] I did not include credentials, personal workspace data, or machine-specific state.
- [ ] Relevant tests pass on this exact revision.
- [ ] New or changed behavior has appropriate tests.
- [ ] Dependency changes include the updated lockfile and required notices.
- [ ] Documentation was updated when user-visible behavior changed.
- [ ] Security-sensitive details were reported privately when appropriate.
