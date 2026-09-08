export type Provider<T> = () => T;

export const singleton = <T>(factory: () => T): Provider<T> => {
  let initialized = false;
  let instance: T;

  return (): T => {
    if (!initialized) {
      instance = factory();
      initialized = true;
    }

    return instance;
  };
};
