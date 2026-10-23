import nextVitals from 'eslint-config-next/core-web-vitals';

const config = [
  ...nextVitals,
  {
    // This rule is newly promoted by the Next 16 toolchain. Existing effects
    // intentionally sync server props or gate browser-only UI until hydration.
    rules: {
      'react-hooks/set-state-in-effect': 'off',
    },
  },
];

export default config;
