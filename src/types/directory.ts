/**
 * IdP-neutral representation of a directory user. Concrete clients map
 * their vendor shape onto this — WorkOS today; swapping providers is a
 * client-file change, not a type surgery.
 */
export interface DirectoryUser {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  state: 'active' | 'suspended' | 'inactive';
}
