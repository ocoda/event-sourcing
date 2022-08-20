interface ValueObjectProps {
  [index: string]: any;
}

export abstract class ValueObject<
  T extends ValueObjectProps = ValueObjectProps,
> {
  public readonly props: T;

  protected constructor(props: T) {
    this.props = Object.freeze(props);
  }

  public equals(other: ValueObject<T>): boolean {
    if (this.constructor !== other.constructor) {
      return false;
    }

    return (
      Object.keys(this.props).length === Object.keys(other.props).length &&
      Object.keys(this.props).every(
        (key) => this.props[key] === other.props[key],
      )
    );
  }
}
