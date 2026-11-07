// An install's org id, as `brake init --org` and the license format accept it. Its own module so
// the dashboard can check one without the signing code.

export const LICENSE_ORG = /^[A-Za-z0-9_-]{1,64}$/;
