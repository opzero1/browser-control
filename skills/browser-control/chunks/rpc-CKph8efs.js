const require_Layer = require("./Layer-Dc3MJVHo.js");
//#region node_modules/.pnpm/effect@3.21.2/node_modules/effect/dist/esm/internal/schema/util.js
/** @internal */
var getKeysForIndexSignature = (input, parameter) => {
	switch (parameter._tag) {
		case "StringKeyword":
		case "TemplateLiteral": return Object.keys(input);
		case "SymbolKeyword": return Object.getOwnPropertySymbols(input);
		case "Refinement": return getKeysForIndexSignature(input, parameter.from);
	}
};
/** @internal */
var memoizeThunk = (f) => {
	let done = false;
	let a;
	return () => {
		if (done) return a;
		a = f();
		done = true;
		return a;
	};
};
/** @internal */
var isNonEmpty$1 = (x) => Array.isArray(x);
/** @internal */
var isSingle = (x) => !Array.isArray(x);
/** @internal */
var formatPathKey = (key) => `[${require_Layer.formatPropertyKey(key)}]`;
/** @internal */
var formatPath = (path) => isNonEmpty$1(path) ? path.map(formatPathKey).join("") : formatPathKey(path);
//#endregion
//#region node_modules/.pnpm/effect@3.21.2/node_modules/effect/dist/esm/internal/schema/errors.js
var getErrorMessage$1 = (reason, details, path, ast) => {
	let out = reason;
	if (path && require_Layer.isNonEmptyReadonlyArray(path)) out += `\nat path: ${formatPath(path)}`;
	if (details !== void 0) out += `\ndetails: ${details}`;
	if (ast) out += `\nschema (${ast._tag}): ${ast}`;
	return out;
};
/** @internal */
var getASTUnsupportedKeySchemaErrorMessage = (ast) => getErrorMessage$1("Unsupported key schema", void 0, void 0, ast);
/** @internal */
var getASTUnsupportedLiteralErrorMessage = (literal) => getErrorMessage$1("Unsupported literal", `literal value: ${require_Layer.formatUnknown(literal)}`);
/** @internal */
var getASTDuplicateIndexSignatureErrorMessage = (type) => getErrorMessage$1("Duplicate index signature", `${type} index signature`);
/** @internal */
var getASTIndexSignatureParameterErrorMessage = /* @__PURE__ */ getErrorMessage$1("Unsupported index signature parameter", "An index signature parameter type must be `string`, `symbol`, a template literal type or a refinement of the previous types");
/** @internal */
var getASTRequiredElementFollowinAnOptionalElementErrorMessage = /* @__PURE__ */ getErrorMessage$1("Invalid element", "A required element cannot follow an optional element. ts(1257)");
/** @internal */
var getASTDuplicatePropertySignatureTransformationErrorMessage = (key) => getErrorMessage$1("Duplicate property signature transformation", `Duplicate key ${require_Layer.formatUnknown(key)}`);
/** @internal */
var getASTDuplicatePropertySignatureErrorMessage = (key) => getErrorMessage$1("Duplicate property signature", `Duplicate key ${require_Layer.formatUnknown(key)}`);
//#endregion
//#region node_modules/.pnpm/effect@3.21.2/node_modules/effect/dist/esm/internal/schema/schemaId.js
/** @internal */
var DateFromSelfSchemaId$1 = /* @__PURE__ */ Symbol.for("effect/SchemaId/DateFromSelf");
/** @internal */
var GreaterThanSchemaId$1 = /* @__PURE__ */ Symbol.for("effect/SchemaId/GreaterThan");
/** @internal */
var GreaterThanOrEqualToSchemaId$1 = /* @__PURE__ */ Symbol.for("effect/SchemaId/GreaterThanOrEqualTo");
/** @internal */
var LessThanSchemaId$1 = /* @__PURE__ */ Symbol.for("effect/SchemaId/LessThan");
/** @internal */
var LessThanOrEqualToSchemaId$1 = /* @__PURE__ */ Symbol.for("effect/SchemaId/LessThanOrEqualTo");
/** @internal */
var IntSchemaId$1 = /* @__PURE__ */ Symbol.for("effect/SchemaId/Int");
/** @internal */
var NonNaNSchemaId$1 = /* @__PURE__ */ Symbol.for("effect/SchemaId/NonNaN");
/** @internal */
var FiniteSchemaId$1 = /* @__PURE__ */ Symbol.for("effect/SchemaId/Finite");
/** @internal */
var JsonNumberSchemaId$1 = /* @__PURE__ */ Symbol.for("effect/SchemaId/JsonNumber");
/** @internal */
var BetweenSchemaId$1 = /* @__PURE__ */ Symbol.for("effect/SchemaId/Between");
/** @internal */
var GreaterThanOrEqualToBigIntSchemaId$1 = /* @__PURE__ */ Symbol.for("effect/SchemaId/GreaterThanOrEqualToBigint");
/** @internal */
var BetweenBigintSchemaId = /* @__PURE__ */ Symbol.for("effect/SchemaId/BetweenBigint");
/** @internal */
var MinLengthSchemaId$1 = /* @__PURE__ */ Symbol.for("effect/SchemaId/MinLength");
/** @internal */
var LengthSchemaId$1 = /* @__PURE__ */ Symbol.for("effect/SchemaId/Length");
//#endregion
//#region node_modules/.pnpm/effect@3.21.2/node_modules/effect/dist/esm/SchemaAST.js
/**
* @since 3.10.0
*/
/**
* @category annotations
* @since 3.19.0
* @experimental
*/
var TypeConstructorAnnotationId = /* @__PURE__ */ Symbol.for("effect/annotation/TypeConstructor");
/**
* @category annotations
* @since 3.10.0
*/
var BrandAnnotationId = /* @__PURE__ */ Symbol.for("effect/annotation/Brand");
/**
* @category annotations
* @since 3.10.0
*/
var SchemaIdAnnotationId = /* @__PURE__ */ Symbol.for("effect/annotation/SchemaId");
/**
* @category annotations
* @since 3.10.0
*/
var MessageAnnotationId = /* @__PURE__ */ Symbol.for("effect/annotation/Message");
/**
* @category annotations
* @since 3.10.0
*/
var MissingMessageAnnotationId = /* @__PURE__ */ Symbol.for("effect/annotation/MissingMessage");
/**
* @category annotations
* @since 3.10.0
*/
var IdentifierAnnotationId = /* @__PURE__ */ Symbol.for("effect/annotation/Identifier");
/**
* @category annotations
* @since 3.10.0
*/
var TitleAnnotationId = /* @__PURE__ */ Symbol.for("effect/annotation/Title");
/** @internal */
var AutoTitleAnnotationId = /* @__PURE__ */ Symbol.for("effect/annotation/AutoTitle");
/**
* @category annotations
* @since 3.10.0
*/
var DescriptionAnnotationId = /* @__PURE__ */ Symbol.for("effect/annotation/Description");
/**
* @category annotations
* @since 3.10.0
*/
var ExamplesAnnotationId = /* @__PURE__ */ Symbol.for("effect/annotation/Examples");
/**
* @category annotations
* @since 3.10.0
*/
var DefaultAnnotationId = /* @__PURE__ */ Symbol.for("effect/annotation/Default");
/**
* @category annotations
* @since 3.10.0
*/
var JSONSchemaAnnotationId = /* @__PURE__ */ Symbol.for("effect/annotation/JSONSchema");
/**
* @category annotations
* @since 3.10.0
*/
var ArbitraryAnnotationId = /* @__PURE__ */ Symbol.for("effect/annotation/Arbitrary");
/**
* @category annotations
* @since 3.10.0
*/
var PrettyAnnotationId = /* @__PURE__ */ Symbol.for("effect/annotation/Pretty");
/**
* @category annotations
* @since 3.10.0
*/
var EquivalenceAnnotationId = /* @__PURE__ */ Symbol.for("effect/annotation/Equivalence");
/**
* @category annotations
* @since 3.10.0
*/
var DocumentationAnnotationId = /* @__PURE__ */ Symbol.for("effect/annotation/Documentation");
/**
* @category annotations
* @since 3.10.0
*/
var ConcurrencyAnnotationId = /* @__PURE__ */ Symbol.for("effect/annotation/Concurrency");
/**
* @category annotations
* @since 3.10.0
*/
var BatchingAnnotationId = /* @__PURE__ */ Symbol.for("effect/annotation/Batching");
/**
* @category annotations
* @since 3.10.0
*/
var ParseIssueTitleAnnotationId = /* @__PURE__ */ Symbol.for("effect/annotation/ParseIssueTitle");
/**
* @category annotations
* @since 3.10.0
*/
var ParseOptionsAnnotationId = /* @__PURE__ */ Symbol.for("effect/annotation/ParseOptions");
/**
* @category annotations
* @since 3.10.0
*/
var DecodingFallbackAnnotationId = /* @__PURE__ */ Symbol.for("effect/annotation/DecodingFallback");
/**
* @category annotations
* @since 3.10.0
*/
var SurrogateAnnotationId = /* @__PURE__ */ Symbol.for("effect/annotation/Surrogate");
/** @internal */
var StableFilterAnnotationId = /* @__PURE__ */ Symbol.for("effect/annotation/StableFilter");
/**
* @category annotations
* @since 3.10.0
*/
var getAnnotation = /* @__PURE__ */ require_Layer.dual(2, (annotated, key) => Object.prototype.hasOwnProperty.call(annotated.annotations, key) ? require_Layer.some(annotated.annotations[key]) : require_Layer.none$1());
/**
* @category annotations
* @since 3.10.0
*/
var getBrandAnnotation = /* @__PURE__ */ getAnnotation(BrandAnnotationId);
/**
* @category annotations
* @since 3.10.0
*/
var getMessageAnnotation = /* @__PURE__ */ getAnnotation(MessageAnnotationId);
/**
* @category annotations
* @since 3.10.0
*/
var getMissingMessageAnnotation = /* @__PURE__ */ getAnnotation(MissingMessageAnnotationId);
/**
* @category annotations
* @since 3.10.0
*/
var getTitleAnnotation = /* @__PURE__ */ getAnnotation(TitleAnnotationId);
/** @internal */
var getAutoTitleAnnotation = /* @__PURE__ */ getAnnotation(AutoTitleAnnotationId);
/**
* @category annotations
* @since 3.10.0
*/
var getIdentifierAnnotation = /* @__PURE__ */ getAnnotation(IdentifierAnnotationId);
/**
* @category annotations
* @since 3.10.0
*/
var getDescriptionAnnotation = /* @__PURE__ */ getAnnotation(DescriptionAnnotationId);
/**
* @category annotations
* @since 3.10.0
*/
var getConcurrencyAnnotation = /* @__PURE__ */ getAnnotation(ConcurrencyAnnotationId);
/**
* @category annotations
* @since 3.10.0
*/
var getBatchingAnnotation = /* @__PURE__ */ getAnnotation(BatchingAnnotationId);
/**
* @category annotations
* @since 3.10.0
*/
var getParseIssueTitleAnnotation$1 = /* @__PURE__ */ getAnnotation(ParseIssueTitleAnnotationId);
/**
* @category annotations
* @since 3.10.0
*/
var getParseOptionsAnnotation = /* @__PURE__ */ getAnnotation(ParseOptionsAnnotationId);
/**
* @category annotations
* @since 3.10.0
*/
var getDecodingFallbackAnnotation = /* @__PURE__ */ getAnnotation(DecodingFallbackAnnotationId);
/**
* @category annotations
* @since 3.10.0
*/
var getSurrogateAnnotation = /* @__PURE__ */ getAnnotation(SurrogateAnnotationId);
var getStableFilterAnnotation = /* @__PURE__ */ getAnnotation(StableFilterAnnotationId);
/** @internal */
var hasStableFilter = (annotated) => require_Layer.exists(getStableFilterAnnotation(annotated), (b) => b === true);
/**
* @category annotations
* @since 3.10.0
*/
var JSONIdentifierAnnotationId = /* @__PURE__ */ Symbol.for("effect/annotation/JSONIdentifier");
/**
* @category annotations
* @since 3.10.0
*/
var getJSONIdentifierAnnotation = /* @__PURE__ */ getAnnotation(JSONIdentifierAnnotationId);
/**
* @category annotations
* @since 3.10.0
*/
var getJSONIdentifier = (annotated) => require_Layer.orElse(getJSONIdentifierAnnotation(annotated), () => getIdentifierAnnotation(annotated));
/**
* @category model
* @since 3.10.0
*/
var Declaration = class {
	typeParameters;
	decodeUnknown;
	encodeUnknown;
	annotations;
	/**
	* @since 3.10.0
	*/
	_tag = "Declaration";
	constructor(typeParameters, decodeUnknown, encodeUnknown, annotations = {}) {
		this.typeParameters = typeParameters;
		this.decodeUnknown = decodeUnknown;
		this.encodeUnknown = encodeUnknown;
		this.annotations = annotations;
	}
	/**
	* @since 3.10.0
	*/
	toString() {
		return require_Layer.getOrElse(getExpected(this), () => "<declaration schema>");
	}
	/**
	* @since 3.10.0
	*/
	toJSON() {
		return {
			_tag: this._tag,
			typeParameters: this.typeParameters.map((ast) => ast.toJSON()),
			annotations: toJSONAnnotations(this.annotations)
		};
	}
};
var createASTGuard = (tag) => (ast) => ast._tag === tag;
/**
* @category model
* @since 3.10.0
*/
var Literal$1 = class {
	literal;
	annotations;
	/**
	* @since 3.10.0
	*/
	_tag = "Literal";
	constructor(literal, annotations = {}) {
		this.literal = literal;
		this.annotations = annotations;
	}
	/**
	* @since 3.10.0
	*/
	toString() {
		return require_Layer.getOrElse(getExpected(this), () => require_Layer.formatUnknown(this.literal));
	}
	/**
	* @since 3.10.0
	*/
	toJSON() {
		return {
			_tag: this._tag,
			literal: require_Layer.isBigInt(this.literal) ? String(this.literal) : this.literal,
			annotations: toJSONAnnotations(this.annotations)
		};
	}
};
/**
* @category guards
* @since 3.10.0
*/
var isLiteral = /* @__PURE__ */ createASTGuard("Literal");
var $null = /* @__PURE__ */ new Literal$1(null);
/**
* @category model
* @since 3.10.0
*/
var UniqueSymbol = class {
	symbol;
	annotations;
	/**
	* @since 3.10.0
	*/
	_tag = "UniqueSymbol";
	constructor(symbol, annotations = {}) {
		this.symbol = symbol;
		this.annotations = annotations;
	}
	/**
	* @since 3.10.0
	*/
	toString() {
		return require_Layer.getOrElse(getExpected(this), () => require_Layer.formatUnknown(this.symbol));
	}
	/**
	* @since 3.10.0
	*/
	toJSON() {
		return {
			_tag: this._tag,
			symbol: String(this.symbol),
			annotations: toJSONAnnotations(this.annotations)
		};
	}
};
/**
* @category model
* @since 3.10.0
*/
var UndefinedKeyword = class {
	annotations;
	/**
	* @since 3.10.0
	*/
	_tag = "UndefinedKeyword";
	constructor(annotations = {}) {
		this.annotations = annotations;
	}
	/**
	* @since 3.10.0
	*/
	toString() {
		return formatKeyword(this);
	}
	/**
	* @since 3.10.0
	*/
	toJSON() {
		return {
			_tag: this._tag,
			annotations: toJSONAnnotations(this.annotations)
		};
	}
};
/**
* @category constructors
* @since 3.10.0
*/
var undefinedKeyword = /* @__PURE__ */ new UndefinedKeyword({ [TitleAnnotationId]: "undefined" });
/**
* @category model
* @since 3.10.0
*/
var NeverKeyword = class {
	annotations;
	/**
	* @since 3.10.0
	*/
	_tag = "NeverKeyword";
	constructor(annotations = {}) {
		this.annotations = annotations;
	}
	/**
	* @since 3.10.0
	*/
	toString() {
		return formatKeyword(this);
	}
	/**
	* @since 3.10.0
	*/
	toJSON() {
		return {
			_tag: this._tag,
			annotations: toJSONAnnotations(this.annotations)
		};
	}
};
/**
* @category constructors
* @since 3.10.0
*/
var neverKeyword = /* @__PURE__ */ new NeverKeyword({ [TitleAnnotationId]: "never" });
/**
* @category model
* @since 3.10.0
*/
var UnknownKeyword = class {
	annotations;
	/**
	* @since 3.10.0
	*/
	_tag = "UnknownKeyword";
	constructor(annotations = {}) {
		this.annotations = annotations;
	}
	/**
	* @since 3.10.0
	*/
	toString() {
		return formatKeyword(this);
	}
	/**
	* @since 3.10.0
	*/
	toJSON() {
		return {
			_tag: this._tag,
			annotations: toJSONAnnotations(this.annotations)
		};
	}
};
/**
* @category constructors
* @since 3.10.0
*/
var unknownKeyword = /* @__PURE__ */ new UnknownKeyword({ [TitleAnnotationId]: "unknown" });
/**
* @category model
* @since 3.10.0
*/
var AnyKeyword = class {
	annotations;
	/**
	* @since 3.10.0
	*/
	_tag = "AnyKeyword";
	constructor(annotations = {}) {
		this.annotations = annotations;
	}
	/**
	* @since 3.10.0
	*/
	toString() {
		return formatKeyword(this);
	}
	/**
	* @since 3.10.0
	*/
	toJSON() {
		return {
			_tag: this._tag,
			annotations: toJSONAnnotations(this.annotations)
		};
	}
};
/**
* @category constructors
* @since 3.10.0
*/
var anyKeyword = /* @__PURE__ */ new AnyKeyword({ [TitleAnnotationId]: "any" });
/**
* @category model
* @since 3.10.0
*/
var StringKeyword = class {
	annotations;
	/**
	* @since 3.10.0
	*/
	_tag = "StringKeyword";
	constructor(annotations = {}) {
		this.annotations = annotations;
	}
	/**
	* @since 3.10.0
	*/
	toString() {
		return formatKeyword(this);
	}
	/**
	* @since 3.10.0
	*/
	toJSON() {
		return {
			_tag: this._tag,
			annotations: toJSONAnnotations(this.annotations)
		};
	}
};
/**
* @category constructors
* @since 3.10.0
*/
var stringKeyword = /* @__PURE__ */ new StringKeyword({
	[TitleAnnotationId]: "string",
	[DescriptionAnnotationId]: "a string"
});
/**
* @category guards
* @since 3.10.0
*/
var isStringKeyword = /* @__PURE__ */ createASTGuard("StringKeyword");
/**
* @category model
* @since 3.10.0
*/
var NumberKeyword = class {
	annotations;
	/**
	* @since 3.10.0
	*/
	_tag = "NumberKeyword";
	constructor(annotations = {}) {
		this.annotations = annotations;
	}
	/**
	* @since 3.10.0
	*/
	toString() {
		return formatKeyword(this);
	}
	/**
	* @since 3.10.0
	*/
	toJSON() {
		return {
			_tag: this._tag,
			annotations: toJSONAnnotations(this.annotations)
		};
	}
};
/**
* @category constructors
* @since 3.10.0
*/
var numberKeyword = /* @__PURE__ */ new NumberKeyword({
	[TitleAnnotationId]: "number",
	[DescriptionAnnotationId]: "a number"
});
/**
* @category model
* @since 3.10.0
*/
var BooleanKeyword = class {
	annotations;
	/**
	* @since 3.10.0
	*/
	_tag = "BooleanKeyword";
	constructor(annotations = {}) {
		this.annotations = annotations;
	}
	/**
	* @since 3.10.0
	*/
	toString() {
		return formatKeyword(this);
	}
	/**
	* @since 3.10.0
	*/
	toJSON() {
		return {
			_tag: this._tag,
			annotations: toJSONAnnotations(this.annotations)
		};
	}
};
/**
* @category constructors
* @since 3.10.0
*/
var booleanKeyword = /* @__PURE__ */ new BooleanKeyword({
	[TitleAnnotationId]: "boolean",
	[DescriptionAnnotationId]: "a boolean"
});
/**
* @category model
* @since 3.10.0
*/
var BigIntKeyword = class {
	annotations;
	/**
	* @since 3.10.0
	*/
	_tag = "BigIntKeyword";
	constructor(annotations = {}) {
		this.annotations = annotations;
	}
	/**
	* @since 3.10.0
	*/
	toString() {
		return formatKeyword(this);
	}
	/**
	* @since 3.10.0
	*/
	toJSON() {
		return {
			_tag: this._tag,
			annotations: toJSONAnnotations(this.annotations)
		};
	}
};
/**
* @category constructors
* @since 3.10.0
*/
var bigIntKeyword = /* @__PURE__ */ new BigIntKeyword({
	[TitleAnnotationId]: "bigint",
	[DescriptionAnnotationId]: "a bigint"
});
/**
* @category model
* @since 3.10.0
*/
var SymbolKeyword = class {
	annotations;
	/**
	* @since 3.10.0
	*/
	_tag = "SymbolKeyword";
	constructor(annotations = {}) {
		this.annotations = annotations;
	}
	/**
	* @since 3.10.0
	*/
	toString() {
		return formatKeyword(this);
	}
	/**
	* @since 3.10.0
	*/
	toJSON() {
		return {
			_tag: this._tag,
			annotations: toJSONAnnotations(this.annotations)
		};
	}
};
/**
* @category constructors
* @since 3.10.0
*/
var symbolKeyword = /* @__PURE__ */ new SymbolKeyword({
	[TitleAnnotationId]: "symbol",
	[DescriptionAnnotationId]: "a symbol"
});
/**
* @category guards
* @since 3.10.0
*/
var isSymbolKeyword = /* @__PURE__ */ createASTGuard("SymbolKeyword");
/**
* @category model
* @since 3.10.0
*/
var Type$1 = class {
	type;
	annotations;
	constructor(type, annotations = {}) {
		this.type = type;
		this.annotations = annotations;
	}
	/**
	* @since 3.10.0
	*/
	toJSON() {
		return {
			type: this.type.toJSON(),
			annotations: toJSONAnnotations(this.annotations)
		};
	}
	/**
	* @since 3.10.0
	*/
	toString() {
		return String(this.type);
	}
};
/**
* @category model
* @since 3.10.0
*/
var OptionalType = class extends Type$1 {
	isOptional;
	constructor(type, isOptional, annotations = {}) {
		super(type, annotations);
		this.isOptional = isOptional;
	}
	/**
	* @since 3.10.0
	*/
	toJSON() {
		return {
			type: this.type.toJSON(),
			isOptional: this.isOptional,
			annotations: toJSONAnnotations(this.annotations)
		};
	}
	/**
	* @since 3.10.0
	*/
	toString() {
		return String(this.type) + (this.isOptional ? "?" : "");
	}
};
var getRestASTs = (rest) => rest.map((annotatedAST) => annotatedAST.type);
/**
* @category model
* @since 3.10.0
*/
var TupleType = class {
	elements;
	rest;
	isReadonly;
	annotations;
	/**
	* @since 3.10.0
	*/
	_tag = "TupleType";
	constructor(elements, rest, isReadonly, annotations = {}) {
		this.elements = elements;
		this.rest = rest;
		this.isReadonly = isReadonly;
		this.annotations = annotations;
		let hasOptionalElement = false;
		let hasIllegalRequiredElement = false;
		for (const e of elements) if (e.isOptional) hasOptionalElement = true;
		else if (hasOptionalElement) {
			hasIllegalRequiredElement = true;
			break;
		}
		if (hasIllegalRequiredElement || hasOptionalElement && rest.length > 1) throw new Error(getASTRequiredElementFollowinAnOptionalElementErrorMessage);
	}
	/**
	* @since 3.10.0
	*/
	toString() {
		return require_Layer.getOrElse(getExpected(this), () => formatTuple(this));
	}
	/**
	* @since 3.10.0
	*/
	toJSON() {
		return {
			_tag: this._tag,
			elements: this.elements.map((e) => e.toJSON()),
			rest: this.rest.map((ast) => ast.toJSON()),
			isReadonly: this.isReadonly,
			annotations: toJSONAnnotations(this.annotations)
		};
	}
};
var formatTuple = (ast) => {
	const formattedElements = ast.elements.map(String).join(", ");
	return require_Layer.matchLeft(ast.rest, {
		onEmpty: () => `readonly [${formattedElements}]`,
		onNonEmpty: (head, tail) => {
			const formattedHead = String(head);
			const wrappedHead = formattedHead.includes(" | ") ? `(${formattedHead})` : formattedHead;
			if (tail.length > 0) {
				const formattedTail = tail.map(String).join(", ");
				if (ast.elements.length > 0) return `readonly [${formattedElements}, ...${wrappedHead}[], ${formattedTail}]`;
				else return `readonly [...${wrappedHead}[], ${formattedTail}]`;
			} else if (ast.elements.length > 0) return `readonly [${formattedElements}, ...${wrappedHead}[]]`;
			else return `ReadonlyArray<${formattedHead}>`;
		}
	});
};
/**
* @category model
* @since 3.10.0
*/
var PropertySignature = class extends OptionalType {
	name;
	isReadonly;
	constructor(name, type, isOptional, isReadonly, annotations) {
		super(type, isOptional, annotations);
		this.name = name;
		this.isReadonly = isReadonly;
	}
	/**
	* @since 3.10.0
	*/
	toString() {
		return (this.isReadonly ? "readonly " : "") + String(this.name) + (this.isOptional ? "?" : "") + ": " + this.type;
	}
	/**
	* @since 3.10.0
	*/
	toJSON() {
		return {
			name: String(this.name),
			type: this.type.toJSON(),
			isOptional: this.isOptional,
			isReadonly: this.isReadonly,
			annotations: toJSONAnnotations(this.annotations)
		};
	}
};
/**
* @since 3.10.0
*/
var isParameter = (ast) => {
	switch (ast._tag) {
		case "StringKeyword":
		case "SymbolKeyword":
		case "TemplateLiteral": return true;
		case "Refinement": return isParameter(ast.from);
	}
	return false;
};
/**
* @category model
* @since 3.10.0
*/
var IndexSignature = class {
	type;
	isReadonly;
	/**
	* @since 3.10.0
	*/
	parameter;
	constructor(parameter, type, isReadonly) {
		this.type = type;
		this.isReadonly = isReadonly;
		if (isParameter(parameter)) this.parameter = parameter;
		else throw new Error(getASTIndexSignatureParameterErrorMessage);
	}
	/**
	* @since 3.10.0
	*/
	toString() {
		return (this.isReadonly ? "readonly " : "") + `[x: ${this.parameter}]: ${this.type}`;
	}
	/**
	* @since 3.10.0
	*/
	toJSON() {
		return {
			parameter: this.parameter.toJSON(),
			type: this.type.toJSON(),
			isReadonly: this.isReadonly
		};
	}
};
/**
* @category model
* @since 3.10.0
*/
var TypeLiteral = class {
	annotations;
	/**
	* @since 3.10.0
	*/
	_tag = "TypeLiteral";
	/**
	* @since 3.10.0
	*/
	propertySignatures;
	/**
	* @since 3.10.0
	*/
	indexSignatures;
	constructor(propertySignatures, indexSignatures, annotations = {}) {
		this.annotations = annotations;
		const keys = {};
		for (let i = 0; i < propertySignatures.length; i++) {
			const name = propertySignatures[i].name;
			if (Object.prototype.hasOwnProperty.call(keys, name)) throw new Error(getASTDuplicatePropertySignatureErrorMessage(name));
			keys[name] = null;
		}
		const parameters = {
			string: false,
			symbol: false
		};
		for (let i = 0; i < indexSignatures.length; i++) {
			const encodedParameter = getEncodedParameter(indexSignatures[i].parameter);
			if (isStringKeyword(encodedParameter)) {
				if (parameters.string) throw new Error(getASTDuplicateIndexSignatureErrorMessage("string"));
				parameters.string = true;
			} else if (isSymbolKeyword(encodedParameter)) {
				if (parameters.symbol) throw new Error(getASTDuplicateIndexSignatureErrorMessage("symbol"));
				parameters.symbol = true;
			}
		}
		this.propertySignatures = propertySignatures;
		this.indexSignatures = indexSignatures;
	}
	/**
	* @since 3.10.0
	*/
	toString() {
		return require_Layer.getOrElse(getExpected(this), () => formatTypeLiteral(this));
	}
	/**
	* @since 3.10.0
	*/
	toJSON() {
		return {
			_tag: this._tag,
			propertySignatures: this.propertySignatures.map((ps) => ps.toJSON()),
			indexSignatures: this.indexSignatures.map((ps) => ps.toJSON()),
			annotations: toJSONAnnotations(this.annotations)
		};
	}
};
var formatIndexSignatures = (iss) => iss.map(String).join("; ");
var formatTypeLiteral = (ast) => {
	if (ast.propertySignatures.length > 0) {
		const pss = ast.propertySignatures.map(String).join("; ");
		if (ast.indexSignatures.length > 0) return `{ ${pss}; ${formatIndexSignatures(ast.indexSignatures)} }`;
		else return `{ ${pss} }`;
	} else if (ast.indexSignatures.length > 0) return `{ ${formatIndexSignatures(ast.indexSignatures)} }`;
	else return "{}";
};
var sortCandidates = /* @__PURE__ */ require_Layer.sort(/* @__PURE__ */ require_Layer.mapInput(require_Layer.Order, (ast) => {
	switch (ast._tag) {
		case "AnyKeyword": return 0;
		case "UnknownKeyword": return 1;
		case "ObjectKeyword": return 2;
		case "StringKeyword":
		case "NumberKeyword":
		case "BooleanKeyword":
		case "BigIntKeyword":
		case "SymbolKeyword": return 3;
	}
	return 4;
}));
var literalMap = {
	string: "StringKeyword",
	number: "NumberKeyword",
	boolean: "BooleanKeyword",
	bigint: "BigIntKeyword"
};
/** @internal */
var flatten = (candidates) => require_Layer.flatMap$1(candidates, (ast) => isUnion(ast) ? flatten(ast.types) : [ast]);
/** @internal */
var unify = (candidates) => {
	const cs = sortCandidates(candidates);
	const out = [];
	const uniques = {};
	const literals = [];
	for (const ast of cs) switch (ast._tag) {
		case "NeverKeyword": break;
		case "AnyKeyword": return [anyKeyword];
		case "UnknownKeyword": return [unknownKeyword];
		case "ObjectKeyword":
		case "UndefinedKeyword":
		case "VoidKeyword":
		case "StringKeyword":
		case "NumberKeyword":
		case "BooleanKeyword":
		case "BigIntKeyword":
		case "SymbolKeyword":
			if (!uniques[ast._tag]) {
				uniques[ast._tag] = ast;
				out.push(ast);
			}
			break;
		case "Literal": {
			const type = typeof ast.literal;
			switch (type) {
				case "string":
				case "number":
				case "bigint":
				case "boolean":
					if (!uniques[literalMap[type]] && !literals.includes(ast.literal)) {
						literals.push(ast.literal);
						out.push(ast);
					}
					break;
				case "object":
					if (!literals.includes(ast.literal)) {
						literals.push(ast.literal);
						out.push(ast);
					}
					break;
			}
			break;
		}
		case "UniqueSymbol":
			if (!uniques["SymbolKeyword"] && !literals.includes(ast.symbol)) {
				literals.push(ast.symbol);
				out.push(ast);
			}
			break;
		case "TupleType":
			if (!uniques["ObjectKeyword"]) out.push(ast);
			break;
		case "TypeLiteral":
			if (ast.propertySignatures.length === 0 && ast.indexSignatures.length === 0) {
				if (!uniques["{}"]) {
					uniques["{}"] = ast;
					out.push(ast);
				}
			} else if (!uniques["ObjectKeyword"]) out.push(ast);
			break;
		default: out.push(ast);
	}
	return out;
};
/**
* @category model
* @since 3.10.0
*/
var Union$1 = class Union$1 {
	types;
	annotations;
	static make = (types, annotations) => {
		return isMembers(types) ? new Union$1(types, annotations) : types.length === 1 ? types[0] : neverKeyword;
	};
	/** @internal */
	static unify = (candidates, annotations) => {
		return Union$1.make(unify(flatten(candidates)), annotations);
	};
	/**
	* @since 3.10.0
	*/
	_tag = "Union";
	constructor(types, annotations = {}) {
		this.types = types;
		this.annotations = annotations;
	}
	/**
	* @since 3.10.0
	*/
	toString() {
		return require_Layer.getOrElse(getExpected(this), () => this.types.map(String).join(" | "));
	}
	/**
	* @since 3.10.0
	*/
	toJSON() {
		return {
			_tag: this._tag,
			types: this.types.map((ast) => ast.toJSON()),
			annotations: toJSONAnnotations(this.annotations)
		};
	}
};
/** @internal */
var mapMembers = (members, f) => members.map(f);
/** @internal */
var isMembers = (as) => as.length > 1;
/**
* @category guards
* @since 3.10.0
*/
var isUnion = /* @__PURE__ */ createASTGuard("Union");
var toJSONMemoMap = /* @__PURE__ */ require_Layer.globalValue(/* @__PURE__ */ Symbol.for("effect/Schema/AST/toJSONMemoMap"), () => /* @__PURE__ */ new WeakMap());
/**
* @category model
* @since 3.10.0
*/
var Suspend = class {
	f;
	annotations;
	/**
	* @since 3.10.0
	*/
	_tag = "Suspend";
	constructor(f, annotations = {}) {
		this.f = f;
		this.annotations = annotations;
		this.f = memoizeThunk(f);
	}
	/**
	* @since 3.10.0
	*/
	toString() {
		return getExpected(this).pipe(require_Layer.orElse(() => require_Layer.flatMap$2(require_Layer.liftThrowable(this.f)(), (ast) => getExpected(ast))), require_Layer.getOrElse(() => "<suspended schema>"));
	}
	/**
	* @since 3.10.0
	*/
	toJSON() {
		const ast = this.f();
		let out = toJSONMemoMap.get(ast);
		if (out) return out;
		toJSONMemoMap.set(ast, { _tag: this._tag });
		out = {
			_tag: this._tag,
			ast: ast.toJSON(),
			annotations: toJSONAnnotations(this.annotations)
		};
		toJSONMemoMap.set(ast, out);
		return out;
	}
};
/**
* @category model
* @since 3.10.0
*/
var Refinement$1 = class {
	from;
	filter;
	annotations;
	/**
	* @since 3.10.0
	*/
	_tag = "Refinement";
	constructor(from, filter, annotations = {}) {
		this.from = from;
		this.filter = filter;
		this.annotations = annotations;
	}
	/**
	* @since 3.10.0
	*/
	toString() {
		return getIdentifierAnnotation(this).pipe(require_Layer.getOrElse(() => require_Layer.match(getOrElseExpected(this), {
			onNone: () => `{ ${this.from} | filter }`,
			onSome: (expected) => isRefinement$1(this.from) ? String(this.from) + " & " + expected : expected
		})));
	}
	/**
	* @since 3.10.0
	*/
	toJSON() {
		return {
			_tag: this._tag,
			from: this.from.toJSON(),
			annotations: toJSONAnnotations(this.annotations)
		};
	}
};
/**
* @category guards
* @since 3.10.0
*/
var isRefinement$1 = /* @__PURE__ */ createASTGuard("Refinement");
/**
* @since 3.10.0
*/
var defaultParseOption = {};
/**
* @category model
* @since 3.10.0
*/
var Transformation$1 = class {
	from;
	to;
	transformation;
	annotations;
	/**
	* @since 3.10.0
	*/
	_tag = "Transformation";
	constructor(from, to, transformation, annotations = {}) {
		this.from = from;
		this.to = to;
		this.transformation = transformation;
		this.annotations = annotations;
	}
	/**
	* @since 3.10.0
	*/
	toString() {
		return require_Layer.getOrElse(getExpected(this), () => `(${String(this.from)} <-> ${String(this.to)})`);
	}
	/**
	* @since 3.10.0
	*/
	toJSON() {
		return {
			_tag: this._tag,
			from: this.from.toJSON(),
			to: this.to.toJSON(),
			annotations: toJSONAnnotations(this.annotations)
		};
	}
};
/**
* @category model
* @since 3.10.0
*/
var FinalTransformation = class {
	decode;
	encode;
	/**
	* @since 3.10.0
	*/
	_tag = "FinalTransformation";
	constructor(decode, encode) {
		this.decode = decode;
		this.encode = encode;
	}
};
/**
* Represents a `PropertySignature -> PropertySignature` transformation
*
* The semantic of `decode` is:
* - `none()` represents the absence of the key/value pair
* - `some(value)` represents the presence of the key/value pair
*
* The semantic of `encode` is:
* - `none()` you don't want to output the key/value pair
* - `some(value)` you want to output the key/value pair
*
* @category model
* @since 3.10.0
*/
var PropertySignatureTransformation$1 = class {
	from;
	to;
	decode;
	encode;
	constructor(from, to, decode, encode) {
		this.from = from;
		this.to = to;
		this.decode = decode;
		this.encode = encode;
	}
};
/**
* @category model
* @since 3.10.0
*/
var TypeLiteralTransformation = class {
	propertySignatureTransformations;
	/**
	* @since 3.10.0
	*/
	_tag = "TypeLiteralTransformation";
	constructor(propertySignatureTransformations) {
		this.propertySignatureTransformations = propertySignatureTransformations;
		const fromKeys = {};
		const toKeys = {};
		for (const pst of propertySignatureTransformations) {
			const from = pst.from;
			if (fromKeys[from]) throw new Error(getASTDuplicatePropertySignatureTransformationErrorMessage(from));
			fromKeys[from] = true;
			const to = pst.to;
			if (toKeys[to]) throw new Error(getASTDuplicatePropertySignatureTransformationErrorMessage(to));
			toKeys[to] = true;
		}
	}
};
/**
* Merges a set of new annotations with existing ones, potentially overwriting
* any duplicates.
*
* Any previously existing identifier annotations are deleted.
*
* @since 3.10.0
*/
var annotations = (ast, overrides) => {
	const d = Object.getOwnPropertyDescriptors(ast);
	const base = { ...ast.annotations };
	delete base[IdentifierAnnotationId];
	const value = {
		...base,
		...overrides
	};
	const surrogate = getSurrogateAnnotation(ast);
	if (require_Layer.isSome(surrogate)) value[SurrogateAnnotationId] = annotations(surrogate.value, overrides);
	d.annotations.value = value;
	return Object.create(Object.getPrototypeOf(ast), d);
};
var STRING_KEYWORD_PATTERN = "[\\s\\S]*?";
var NUMBER_KEYWORD_PATTERN = "[+-]?\\d*\\.?\\d+(?:[Ee][+-]?\\d+)?";
var getTemplateLiteralSpanTypePattern = (type, capture) => {
	switch (type._tag) {
		case "Literal": return require_Layer.escape(String(type.literal));
		case "StringKeyword": return STRING_KEYWORD_PATTERN;
		case "NumberKeyword": return NUMBER_KEYWORD_PATTERN;
		case "TemplateLiteral": return getTemplateLiteralPattern(type, capture, false);
		case "Union": return type.types.map((type) => getTemplateLiteralSpanTypePattern(type, capture)).join("|");
	}
};
var handleTemplateLiteralSpanTypeParens = (type, s, capture, top) => {
	if (isUnion(type)) {
		if (capture && !top) return `(?:${s})`;
	} else if (!capture || !top) return s;
	return `(${s})`;
};
var getTemplateLiteralPattern = (ast, capture, top) => {
	let pattern = ``;
	if (ast.head !== "") {
		const head = require_Layer.escape(ast.head);
		pattern += capture && top ? `(${head})` : head;
	}
	for (const span of ast.spans) {
		const spanPattern = getTemplateLiteralSpanTypePattern(span.type, capture);
		pattern += handleTemplateLiteralSpanTypeParens(span.type, spanPattern, capture, top);
		if (span.literal !== "") {
			const literal = require_Layer.escape(span.literal);
			pattern += capture && top ? `(${literal})` : literal;
		}
	}
	return pattern;
};
/**
* Generates a regular expression from a `TemplateLiteral` AST node.
*
* @see {@link getTemplateLiteralCapturingRegExp} for a variant that captures the pattern.
*
* @since 3.10.0
*/
var getTemplateLiteralRegExp = (ast) => new RegExp(`^${getTemplateLiteralPattern(ast, false, true)}$`);
/** @internal */
var record = (key, value) => {
	const propertySignatures = [];
	const indexSignatures = [];
	const go = (key) => {
		switch (key._tag) {
			case "NeverKeyword": break;
			case "StringKeyword":
			case "SymbolKeyword":
			case "TemplateLiteral":
			case "Refinement":
				indexSignatures.push(new IndexSignature(key, value, true));
				break;
			case "Literal":
				if (require_Layer.isString(key.literal) || require_Layer.isNumber(key.literal)) propertySignatures.push(new PropertySignature(key.literal, value, false, true));
				else throw new Error(getASTUnsupportedLiteralErrorMessage(key.literal));
				break;
			case "Enums":
				for (const [_, name] of key.enums) propertySignatures.push(new PropertySignature(name, value, false, true));
				break;
			case "UniqueSymbol":
				propertySignatures.push(new PropertySignature(key.symbol, value, false, true));
				break;
			case "Union":
				key.types.forEach(go);
				break;
			default: throw new Error(getASTUnsupportedKeySchemaErrorMessage(key));
		}
	};
	go(key);
	return {
		propertySignatures,
		indexSignatures
	};
};
/** @internal */
var pickAnnotations = (annotationIds) => (annotated) => {
	let out = void 0;
	for (const id of annotationIds) if (Object.prototype.hasOwnProperty.call(annotated.annotations, id)) {
		if (out === void 0) out = {};
		out[id] = annotated.annotations[id];
	}
	return out;
};
var preserveTransformationAnnotations = /* @__PURE__ */ pickAnnotations([
	ExamplesAnnotationId,
	DefaultAnnotationId,
	JSONSchemaAnnotationId,
	ArbitraryAnnotationId,
	PrettyAnnotationId,
	EquivalenceAnnotationId
]);
/**
* @since 3.10.0
*/
var typeAST = (ast) => {
	switch (ast._tag) {
		case "Declaration": {
			const typeParameters = changeMap(ast.typeParameters, typeAST);
			return typeParameters === ast.typeParameters ? ast : new Declaration(typeParameters, ast.decodeUnknown, ast.encodeUnknown, ast.annotations);
		}
		case "TupleType": {
			const elements = changeMap(ast.elements, (e) => {
				const type = typeAST(e.type);
				return type === e.type ? e : new OptionalType(type, e.isOptional);
			});
			const restASTs = getRestASTs(ast.rest);
			const rest = changeMap(restASTs, typeAST);
			return elements === ast.elements && rest === restASTs ? ast : new TupleType(elements, rest.map((type) => new Type$1(type)), ast.isReadonly, ast.annotations);
		}
		case "TypeLiteral": {
			const propertySignatures = changeMap(ast.propertySignatures, (p) => {
				const type = typeAST(p.type);
				return type === p.type ? p : new PropertySignature(p.name, type, p.isOptional, p.isReadonly);
			});
			const indexSignatures = changeMap(ast.indexSignatures, (is) => {
				const type = typeAST(is.type);
				return type === is.type ? is : new IndexSignature(is.parameter, type, is.isReadonly);
			});
			return propertySignatures === ast.propertySignatures && indexSignatures === ast.indexSignatures ? ast : new TypeLiteral(propertySignatures, indexSignatures, ast.annotations);
		}
		case "Union": {
			const types = changeMap(ast.types, typeAST);
			return types === ast.types ? ast : Union$1.make(types, ast.annotations);
		}
		case "Suspend": return new Suspend(() => typeAST(ast.f()), ast.annotations);
		case "Refinement": {
			const from = typeAST(ast.from);
			return from === ast.from ? ast : new Refinement$1(from, ast.filter, ast.annotations);
		}
		case "Transformation": {
			const preserve = preserveTransformationAnnotations(ast);
			return typeAST(preserve !== void 0 ? annotations(ast.to, preserve) : ast.to);
		}
	}
	return ast;
};
function changeMap(as, f) {
	let changed = false;
	const out = require_Layer.allocate(as.length);
	for (let i = 0; i < as.length; i++) {
		const a = as[i];
		const fa = f(a);
		if (fa !== a) changed = true;
		out[i] = fa;
	}
	return changed ? out : as;
}
/**
* Returns the from part of a transformation if it exists
*
* @internal
*/
var getTransformationFrom = (ast) => {
	switch (ast._tag) {
		case "Transformation": return ast.from;
		case "Refinement": return getTransformationFrom(ast.from);
		case "Suspend": return getTransformationFrom(ast.f());
	}
};
var encodedAST_ = (ast, isBound) => {
	switch (ast._tag) {
		case "Declaration": {
			const typeParameters = changeMap(ast.typeParameters, (ast) => encodedAST_(ast, isBound));
			return typeParameters === ast.typeParameters ? ast : new Declaration(typeParameters, ast.decodeUnknown, ast.encodeUnknown);
		}
		case "TupleType": {
			const elements = changeMap(ast.elements, (e) => {
				const type = encodedAST_(e.type, isBound);
				return type === e.type ? e : new OptionalType(type, e.isOptional);
			});
			const restASTs = getRestASTs(ast.rest);
			const rest = changeMap(restASTs, (ast) => encodedAST_(ast, isBound));
			return elements === ast.elements && rest === restASTs ? ast : new TupleType(elements, rest.map((ast) => new Type$1(ast)), ast.isReadonly);
		}
		case "TypeLiteral": {
			const propertySignatures = changeMap(ast.propertySignatures, (ps) => {
				const type = encodedAST_(ps.type, isBound);
				return type === ps.type ? ps : new PropertySignature(ps.name, type, ps.isOptional, ps.isReadonly);
			});
			const indexSignatures = changeMap(ast.indexSignatures, (is) => {
				const type = encodedAST_(is.type, isBound);
				return type === is.type ? is : new IndexSignature(is.parameter, type, is.isReadonly);
			});
			return propertySignatures === ast.propertySignatures && indexSignatures === ast.indexSignatures ? ast : new TypeLiteral(propertySignatures, indexSignatures);
		}
		case "Union": {
			const types = changeMap(ast.types, (ast) => encodedAST_(ast, isBound));
			return types === ast.types ? ast : Union$1.make(types);
		}
		case "Suspend": {
			let borrowedAnnotations = void 0;
			const identifier = getJSONIdentifier(ast);
			if (require_Layer.isSome(identifier)) {
				const suffix = isBound ? "Bound" : "";
				borrowedAnnotations = { [JSONIdentifierAnnotationId]: `${identifier.value}Encoded${suffix}` };
			}
			return new Suspend(() => encodedAST_(ast.f(), isBound), borrowedAnnotations);
		}
		case "Refinement": {
			const from = encodedAST_(ast.from, isBound);
			if (isBound) {
				if (from === ast.from) return ast;
				if (getTransformationFrom(ast.from) === void 0 && hasStableFilter(ast)) return new Refinement$1(from, ast.filter, ast.annotations);
				return from;
			} else return from;
		}
		case "Transformation": return encodedAST_(ast.from, isBound);
	}
	return ast;
};
/**
* @since 3.10.0
*/
var encodedAST = (ast) => encodedAST_(ast, false);
var toJSONAnnotations = (annotations) => {
	const out = {};
	for (const k of Object.getOwnPropertySymbols(annotations)) out[String(k)] = annotations[k];
	return out;
};
/** @internal */
var getEncodedParameter = (ast) => {
	switch (ast._tag) {
		case "StringKeyword":
		case "SymbolKeyword":
		case "TemplateLiteral": return ast;
		case "Refinement": return getEncodedParameter(ast.from);
	}
};
var formatKeyword = (ast) => require_Layer.getOrElse(getExpected(ast), () => ast._tag);
function getBrands(ast) {
	return require_Layer.match(getBrandAnnotation(ast), {
		onNone: () => "",
		onSome: (brands) => brands.map((brand) => ` & Brand<${require_Layer.formatUnknown(brand)}>`).join("")
	});
}
var getOrElseExpected = (ast) => getTitleAnnotation(ast).pipe(require_Layer.orElse(() => getDescriptionAnnotation(ast)), require_Layer.orElse(() => getAutoTitleAnnotation(ast)), require_Layer.map$1((s) => s + getBrands(ast)));
var getExpected = (ast) => require_Layer.orElse(getIdentifierAnnotation(ast), () => getOrElseExpected(ast));
//#endregion
//#region node_modules/.pnpm/effect@3.21.2/node_modules/effect/dist/esm/BigDecimal.js
/**
* This module provides utility functions and type class instances for working with the `BigDecimal` type in TypeScript.
* It includes functions for basic arithmetic operations, as well as type class instances for `Equivalence` and `Order`.
*
* A `BigDecimal` allows storing any real number to arbitrary precision; which avoids common floating point errors
* (such as 0.1 + 0.2 ≠ 0.3) at the cost of complexity.
*
* Internally, `BigDecimal` uses a `BigInt` object, paired with a 64-bit integer which determines the position of the
* decimal point. Therefore, the precision *is not* actually arbitrary, but limited to 2<sup>63</sup> decimal places.
*
* It is not recommended to convert a floating point number to a decimal directly, as the floating point representation
* may be unexpected.
*
* @module BigDecimal
* @since 2.0.0
* @see {@link module:BigInt} for more similar operations on `bigint` types
* @see {@link module:Number} for more similar operations on `number` types
*/
var FINITE_INT_REGEX = /^[+-]?\d+$/;
/**
* @since 2.0.0
* @category symbols
*/
var TypeId$2 = /* @__PURE__ */ Symbol.for("effect/BigDecimal");
var BigDecimalProto = {
	[TypeId$2]: TypeId$2,
	[require_Layer.symbol$1]() {
		const normalized = normalize(this);
		return require_Layer.pipe(require_Layer.hash(normalized.value), require_Layer.combine(require_Layer.number(normalized.scale)), require_Layer.cached(this));
	},
	[require_Layer.symbol](that) {
		return isBigDecimal(that) && equals(this, that);
	},
	toString() {
		return `BigDecimal(${format$1(this)})`;
	},
	toJSON() {
		return {
			_id: "BigDecimal",
			value: String(this.value),
			scale: this.scale
		};
	},
	[require_Layer.NodeInspectSymbol]() {
		return this.toJSON();
	},
	pipe() {
		return require_Layer.pipeArguments(this, arguments);
	}
};
/**
* Checks if a given value is a `BigDecimal`.
*
* @since 2.0.0
* @category guards
*/
var isBigDecimal = (u) => require_Layer.hasProperty(u, TypeId$2);
/**
* Creates a `BigDecimal` from a `bigint` value and a scale.
*
* @since 2.0.0
* @category constructors
*/
var make$1 = (value, scale) => {
	const o = Object.create(BigDecimalProto);
	o.value = value;
	o.scale = scale;
	return o;
};
/**
* Internal function used to create pre-normalized `BigDecimal`s.
*
* @internal
*/
var unsafeMakeNormalized = (value, scale) => {
	if (value !== bigint0 && value % bigint10 === bigint0) throw new RangeError("Value must be normalized");
	const o = make$1(value, scale);
	o.normalized = o;
	return o;
};
var bigint0 = /* @__PURE__ */ BigInt(0);
var bigint10 = /* @__PURE__ */ BigInt(10);
var zero = /* @__PURE__ */ unsafeMakeNormalized(bigint0, 0);
/**
* Normalizes a given `BigDecimal` by removing trailing zeros.
*
* **Example**
*
* ```ts
* import * as assert from "node:assert"
* import { normalize, make, unsafeFromString } from "effect/BigDecimal"
*
* assert.deepStrictEqual(normalize(unsafeFromString("123.00000")), normalize(make(123n, 0)))
* assert.deepStrictEqual(normalize(unsafeFromString("12300000")), normalize(make(123n, -5)))
* ```
*
* @since 2.0.0
* @category scaling
*/
var normalize = (self) => {
	if (self.normalized === void 0) if (self.value === bigint0) self.normalized = zero;
	else {
		const digits = `${self.value}`;
		let trail = 0;
		for (let i = digits.length - 1; i >= 0; i--) if (digits[i] === "0") trail++;
		else break;
		if (trail === 0) self.normalized = self;
		self.normalized = unsafeMakeNormalized(BigInt(digits.substring(0, digits.length - trail)), self.scale - trail);
	}
	return self.normalized;
};
/**
* Scales a given `BigDecimal` to the specified scale.
*
* If the given scale is smaller than the current scale, the value will be rounded down to
* the nearest integer.
*
* @since 2.0.0
* @category scaling
*/
var scale = /* @__PURE__ */ require_Layer.dual(2, (self, scale) => {
	if (scale > self.scale) return make$1(self.value * bigint10 ** BigInt(scale - self.scale), scale);
	if (scale < self.scale) return make$1(self.value / bigint10 ** BigInt(self.scale - scale), scale);
	return self;
});
/**
* Determines the absolute value of a given `BigDecimal`.
*
* @example
* ```ts
* import * as assert from "node:assert"
* import { abs, unsafeFromString } from "effect/BigDecimal"
*
* assert.deepStrictEqual(abs(unsafeFromString("-5")), unsafeFromString("5"))
* assert.deepStrictEqual(abs(unsafeFromString("0")), unsafeFromString("0"))
* assert.deepStrictEqual(abs(unsafeFromString("5")), unsafeFromString("5"))
* ```
*
* @since 2.0.0
* @category math
*/
var abs = (n) => n.value < bigint0 ? make$1(-n.value, n.scale) : n;
/**
* @category instances
* @since 2.0.0
*/
var Equivalence$2 = /* @__PURE__ */ require_Layer.make((self, that) => {
	if (self.scale > that.scale) return scale(that, self.scale).value === self.value;
	if (self.scale < that.scale) return scale(self, that.scale).value === that.value;
	return self.value === that.value;
});
/**
* Checks if two `BigDecimal`s are equal.
*
* @since 2.0.0
* @category predicates
*/
var equals = /* @__PURE__ */ require_Layer.dual(2, (self, that) => Equivalence$2(self, that));
/**
* Creates a `BigDecimal` from a `number` value.
*
* It is not recommended to convert a floating point number to a decimal directly,
* as the floating point representation may be unexpected.
*
* Throws a `RangeError` if the number is not finite (`NaN`, `+Infinity` or `-Infinity`).
*
* @example
* ```ts
* import * as assert from "node:assert"
* import { unsafeFromNumber, make } from "effect/BigDecimal"
*
* assert.deepStrictEqual(unsafeFromNumber(123), make(123n, 0))
* assert.deepStrictEqual(unsafeFromNumber(123.456), make(123456n, 3))
* ```
*
* @since 3.11.0
* @category constructors
*/
var unsafeFromNumber = (n) => require_Layer.getOrThrowWith(safeFromNumber(n), () => /* @__PURE__ */ new RangeError(`Number must be finite, got ${n}`));
/**
* Creates a `BigDecimal` from a `number` value.
*
* It is not recommended to convert a floating point number to a decimal directly,
* as the floating point representation may be unexpected.
*
* Returns `None` if the number is not finite (`NaN`, `+Infinity` or `-Infinity`).
*
* @example
* ```ts
* import * as assert from "node:assert"
* import { BigDecimal, Option } from "effect"
*
* assert.deepStrictEqual(BigDecimal.safeFromNumber(123), Option.some(BigDecimal.make(123n, 0)))
* assert.deepStrictEqual(BigDecimal.safeFromNumber(123.456), Option.some(BigDecimal.make(123456n, 3)))
* assert.deepStrictEqual(BigDecimal.safeFromNumber(Infinity), Option.none())
* ```
*
* @since 3.11.0
* @category constructors
*/
var safeFromNumber = (n) => {
	if (!Number.isFinite(n)) return require_Layer.none$1();
	const string = `${n}`;
	if (string.includes("e")) return fromString$1(string);
	const [lead, trail = ""] = string.split(".");
	return require_Layer.some(make$1(BigInt(`${lead}${trail}`), trail.length));
};
/**
* Parses a numerical `string` into a `BigDecimal`.
*
* @example
* ```ts
* import * as assert from "node:assert"
* import { BigDecimal, Option } from "effect"
*
* assert.deepStrictEqual(BigDecimal.fromString("123"), Option.some(BigDecimal.make(123n, 0)))
* assert.deepStrictEqual(BigDecimal.fromString("123.456"), Option.some(BigDecimal.make(123456n, 3)))
* assert.deepStrictEqual(BigDecimal.fromString("123.abc"), Option.none())
* ```
*
* @since 2.0.0
* @category constructors
*/
var fromString$1 = (s) => {
	if (s === "") return require_Layer.some(zero);
	let base;
	let exp;
	const seperator = s.search(/[eE]/);
	if (seperator !== -1) {
		const trail = s.slice(seperator + 1);
		base = s.slice(0, seperator);
		exp = Number(trail);
		if (base === "" || !Number.isSafeInteger(exp) || !FINITE_INT_REGEX.test(trail)) return require_Layer.none$1();
	} else {
		base = s;
		exp = 0;
	}
	let digits;
	let offset;
	const dot = base.search(/\./);
	if (dot !== -1) {
		const lead = base.slice(0, dot);
		const trail = base.slice(dot + 1);
		digits = `${lead}${trail}`;
		offset = trail.length;
	} else {
		digits = base;
		offset = 0;
	}
	if (!FINITE_INT_REGEX.test(digits)) return require_Layer.none$1();
	const scale = offset - exp;
	if (!Number.isSafeInteger(scale)) return require_Layer.none$1();
	return require_Layer.some(make$1(BigInt(digits), scale));
};
/**
* Formats a given `BigDecimal` as a `string`.
*
* If the scale of the `BigDecimal` is greater than or equal to 16, the `BigDecimal` will
* be formatted in scientific notation.
*
* @example
* ```ts
* import * as assert from "node:assert"
* import { format, unsafeFromString } from "effect/BigDecimal"
*
* assert.deepStrictEqual(format(unsafeFromString("-5")), "-5")
* assert.deepStrictEqual(format(unsafeFromString("123.456")), "123.456")
* assert.deepStrictEqual(format(unsafeFromString("-0.00000123")), "-0.00000123")
* ```
*
* @since 2.0.0
* @category conversions
*/
var format$1 = (n) => {
	const normalized = normalize(n);
	if (Math.abs(normalized.scale) >= 16) return toExponential(normalized);
	const negative = normalized.value < bigint0;
	const absolute = negative ? `${normalized.value}`.substring(1) : `${normalized.value}`;
	let before;
	let after;
	if (normalized.scale >= absolute.length) {
		before = "0";
		after = "0".repeat(normalized.scale - absolute.length) + absolute;
	} else {
		const location = absolute.length - normalized.scale;
		if (location > absolute.length) {
			const zeros = location - absolute.length;
			before = `${absolute}${"0".repeat(zeros)}`;
			after = "";
		} else {
			after = absolute.slice(location);
			before = absolute.slice(0, location);
		}
	}
	const complete = after === "" ? before : `${before}.${after}`;
	return negative ? `-${complete}` : complete;
};
/**
* Formats a given `BigDecimal` as a `string` in scientific notation.
*
* @example
* ```ts
* import * as assert from "node:assert"
* import { toExponential, make } from "effect/BigDecimal"
*
* assert.deepStrictEqual(toExponential(make(123456n, -5)), "1.23456e+10")
* ```
*
* @since 3.11.0
* @category conversions
*/
var toExponential = (n) => {
	if (isZero(n)) return "0e+0";
	const normalized = normalize(n);
	const digits = `${abs(normalized).value}`;
	const head = digits.slice(0, 1);
	const tail = digits.slice(1);
	let output = `${isNegative(normalized) ? "-" : ""}${head}`;
	if (tail !== "") output += `.${tail}`;
	const exp = tail.length - normalized.scale;
	return `${output}e${exp >= 0 ? "+" : ""}${exp}`;
};
/**
* Converts a `BigDecimal` to a `number`.
*
* This function will produce incorrect results if the `BigDecimal` exceeds the 64-bit range of a `number`.
*
* @example
* ```ts
* import * as assert from "node:assert"
* import { unsafeToNumber, unsafeFromString } from "effect/BigDecimal"
*
* assert.deepStrictEqual(unsafeToNumber(unsafeFromString("123.456")), 123.456)
* ```
*
* @since 2.0.0
* @category conversions
*/
var unsafeToNumber = (n) => Number(format$1(n));
/**
* Checks if a given `BigDecimal` is `0`.
*
* @example
* ```ts
* import * as assert from "node:assert"
* import { isZero, unsafeFromString } from "effect/BigDecimal"
*
* assert.deepStrictEqual(isZero(unsafeFromString("0")), true)
* assert.deepStrictEqual(isZero(unsafeFromString("1")), false)
* ```
*
* @since 2.0.0
* @category predicates
*/
var isZero = (n) => n.value === bigint0;
/**
* Checks if a given `BigDecimal` is negative.
*
* @example
* ```ts
* import * as assert from "node:assert"
* import { isNegative, unsafeFromString } from "effect/BigDecimal"
*
* assert.deepStrictEqual(isNegative(unsafeFromString("-1")), true)
* assert.deepStrictEqual(isNegative(unsafeFromString("0")), false)
* assert.deepStrictEqual(isNegative(unsafeFromString("1")), false)
* ```
*
* @since 2.0.0
* @category predicates
*/
var isNegative = (n) => n.value < bigint0;
//#endregion
//#region node_modules/.pnpm/effect@3.21.2/node_modules/effect/dist/esm/BigInt.js
/**
* Takes a `bigint` and returns an `Option` of `number`.
*
* If the `bigint` is outside the safe integer range for JavaScript (`Number.MAX_SAFE_INTEGER`
* and `Number.MIN_SAFE_INTEGER`), it returns `Option.none()`. Otherwise, it converts the `bigint`
* to a number and returns `Option.some(number)`.
*
* @example
* ```ts
* import * as assert from "node:assert"
* import { BigInt as BI, Option } from "effect"
*
* assert.deepStrictEqual(BI.toNumber(BigInt(42)), Option.some(42))
* assert.deepStrictEqual(BI.toNumber(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1)), Option.none())
* assert.deepStrictEqual(BI.toNumber(BigInt(Number.MIN_SAFE_INTEGER) - BigInt(1)), Option.none())
* ```
*
* @category conversions
* @since 2.0.0
*/
var toNumber = (b) => {
	if (b > BigInt(Number.MAX_SAFE_INTEGER) || b < BigInt(Number.MIN_SAFE_INTEGER)) return require_Layer.none$1();
	return require_Layer.some(Number(b));
};
/**
* Takes a string and returns an `Option` of `bigint`.
*
* If the string is empty or contains characters that cannot be converted into a `bigint`,
* it returns `Option.none()`, otherwise, it returns `Option.some(bigint)`.
*
* @example
* ```ts
* import * as assert from "node:assert"
* import { BigInt as BI, Option } from "effect"
*
* assert.deepStrictEqual(BI.fromString("42"), Option.some(BigInt(42)))
* assert.deepStrictEqual(BI.fromString(" "), Option.none())
* assert.deepStrictEqual(BI.fromString("a"), Option.none())
* ```
*
* @category conversions
* @since 2.4.12
*/
var fromString = (s) => {
	try {
		return s.trim() === "" ? require_Layer.none$1() : require_Layer.some(BigInt(s));
	} catch {
		return require_Layer.none$1();
	}
};
/**
* Takes a number and returns an `Option` of `bigint`.
*
* If the number is outside the safe integer range for JavaScript (`Number.MAX_SAFE_INTEGER`
* and `Number.MIN_SAFE_INTEGER`), it returns `Option.none()`. Otherwise, it attempts to
* convert the number to a `bigint` and returns `Option.some(bigint)`.
*
* @example
* ```ts
* import * as assert from "node:assert"
* import { BigInt as BI, Option } from "effect"
*
* assert.deepStrictEqual(BI.fromNumber(42), Option.some(BigInt(42)))
* assert.deepStrictEqual(BI.fromNumber(Number.MAX_SAFE_INTEGER + 1), Option.none())
* assert.deepStrictEqual(BI.fromNumber(Number.MIN_SAFE_INTEGER - 1), Option.none())
* ```
*
* @category conversions
* @since 2.4.12
*/
var fromNumber = (n) => {
	if (n > Number.MAX_SAFE_INTEGER || n < Number.MIN_SAFE_INTEGER) return require_Layer.none$1();
	try {
		return require_Layer.some(BigInt(n));
	} catch {
		return require_Layer.none$1();
	}
};
//#endregion
//#region node_modules/.pnpm/effect@3.21.2/node_modules/effect/dist/esm/Data.js
/**
* Provides a constructor for a Case Class.
*
* @since 2.0.0
* @category constructors
*/
var Error$1 = /* @__PURE__ */ function() {
	const plainArgsSymbol = /* @__PURE__ */ Symbol.for("effect/Data/Error/plainArgs");
	return { BaseEffectError: class extends require_Layer.YieldableError {
		constructor(args) {
			super(args?.message, args?.cause ? { cause: args.cause } : void 0);
			if (args) {
				Object.assign(this, args);
				Object.defineProperty(this, plainArgsSymbol, {
					value: args,
					enumerable: false
				});
			}
		}
		toJSON() {
			return {
				...this[plainArgsSymbol],
				...this
			};
		}
	} }.BaseEffectError;
}();
/**
* @since 2.0.0
* @category constructors
*/
var TaggedError = (tag) => {
	const O = { BaseEffectError: class extends Error$1 {
		_tag = tag;
	} };
	O.BaseEffectError.prototype.name = tag;
	return O.BaseEffectError;
};
//#endregion
//#region node_modules/.pnpm/effect@3.21.2/node_modules/effect/dist/esm/internal/dateTime.js
/** @internal */
var TypeId$1 = /* @__PURE__ */ Symbol.for("effect/DateTime");
/** @internal */
var TimeZoneTypeId = /* @__PURE__ */ Symbol.for("effect/DateTime/TimeZone");
var Proto = {
	[TypeId$1]: TypeId$1,
	pipe() {
		return require_Layer.pipeArguments(this, arguments);
	},
	[require_Layer.NodeInspectSymbol]() {
		return this.toString();
	},
	toJSON() {
		return toDateUtc$1(this).toJSON();
	}
};
var ProtoUtc = {
	...Proto,
	_tag: "Utc",
	[require_Layer.symbol$1]() {
		return require_Layer.cached(this, require_Layer.number(this.epochMillis));
	},
	[require_Layer.symbol](that) {
		return isDateTime$1(that) && that._tag === "Utc" && this.epochMillis === that.epochMillis;
	},
	toString() {
		return `DateTime.Utc(${toDateUtc$1(this).toJSON()})`;
	}
};
var ProtoZoned = {
	...Proto,
	_tag: "Zoned",
	[require_Layer.symbol$1]() {
		return require_Layer.pipe(require_Layer.number(this.epochMillis), require_Layer.combine(require_Layer.hash(this.zone)), require_Layer.cached(this));
	},
	[require_Layer.symbol](that) {
		return isDateTime$1(that) && that._tag === "Zoned" && this.epochMillis === that.epochMillis && require_Layer.equals(this.zone, that.zone);
	},
	toString() {
		return `DateTime.Zoned(${formatIsoZoned$1(this)})`;
	}
};
var ProtoTimeZone = {
	[TimeZoneTypeId]: TimeZoneTypeId,
	[require_Layer.NodeInspectSymbol]() {
		return this.toString();
	}
};
var ProtoTimeZoneNamed = {
	...ProtoTimeZone,
	_tag: "Named",
	[require_Layer.symbol$1]() {
		return require_Layer.cached(this, require_Layer.string(`Named:${this.id}`));
	},
	[require_Layer.symbol](that) {
		return isTimeZone(that) && that._tag === "Named" && this.id === that.id;
	},
	toString() {
		return `TimeZone.Named(${this.id})`;
	},
	toJSON() {
		return {
			_id: "TimeZone",
			_tag: "Named",
			id: this.id
		};
	}
};
var ProtoTimeZoneOffset = {
	...ProtoTimeZone,
	_tag: "Offset",
	[require_Layer.symbol$1]() {
		return require_Layer.cached(this, require_Layer.string(`Offset:${this.offset}`));
	},
	[require_Layer.symbol](that) {
		return isTimeZone(that) && that._tag === "Offset" && this.offset === that.offset;
	},
	toString() {
		return `TimeZone.Offset(${offsetToString(this.offset)})`;
	},
	toJSON() {
		return {
			_id: "TimeZone",
			_tag: "Offset",
			offset: this.offset
		};
	}
};
/** @internal */
var makeZonedProto = (epochMillis, zone, partsUtc) => {
	const self = Object.create(ProtoZoned);
	self.epochMillis = epochMillis;
	self.zone = zone;
	Object.defineProperty(self, "partsUtc", {
		value: partsUtc,
		enumerable: false,
		writable: true
	});
	Object.defineProperty(self, "adjustedEpochMillis", {
		value: void 0,
		enumerable: false,
		writable: true
	});
	Object.defineProperty(self, "partsAdjusted", {
		value: void 0,
		enumerable: false,
		writable: true
	});
	return self;
};
/** @internal */
var isDateTime$1 = (u) => require_Layer.hasProperty(u, TypeId$1);
/** @internal */
var isTimeZone = (u) => require_Layer.hasProperty(u, TimeZoneTypeId);
/** @internal */
var isTimeZoneOffset$1 = (u) => isTimeZone(u) && u._tag === "Offset";
/** @internal */
var isTimeZoneNamed$1 = (u) => isTimeZone(u) && u._tag === "Named";
/** @internal */
var isUtc$1 = (self) => self._tag === "Utc";
/** @internal */
var isZoned$1 = (self) => self._tag === "Zoned";
/** @internal */
var Equivalence$1 = /* @__PURE__ */ require_Layer.make((a, b) => a.epochMillis === b.epochMillis);
var makeUtc = (epochMillis) => {
	const self = Object.create(ProtoUtc);
	self.epochMillis = epochMillis;
	Object.defineProperty(self, "partsUtc", {
		value: void 0,
		enumerable: false,
		writable: true
	});
	return self;
};
/** @internal */
var unsafeFromDate$1 = (date) => {
	const epochMillis = date.getTime();
	if (Number.isNaN(epochMillis)) throw new require_Layer.IllegalArgumentException("Invalid date");
	return makeUtc(epochMillis);
};
/** @internal */
var unsafeMake$1 = (input) => {
	if (isDateTime$1(input)) return input;
	else if (input instanceof Date) return unsafeFromDate$1(input);
	else if (typeof input === "object") {
		const date = /* @__PURE__ */ new Date(0);
		setPartsDate(date, input);
		return unsafeFromDate$1(date);
	} else if (typeof input === "string" && !hasZone(input)) return unsafeFromDate$1(/* @__PURE__ */ new Date(input + "Z"));
	return unsafeFromDate$1(new Date(input));
};
var hasZone = (input) => /Z|[+-]\d{2}$|[+-]\d{2}:?\d{2}$|\]$/.test(input);
var minEpochMillis = -86399999568e5;
var maxEpochMillis = 864e13 - 840 * 60 * 1e3;
/** @internal */
var unsafeMakeZoned$1 = (input, options) => {
	if (options?.timeZone === void 0 && isDateTime$1(input) && isZoned$1(input)) return input;
	const self = unsafeMake$1(input);
	if (self.epochMillis < minEpochMillis || self.epochMillis > maxEpochMillis) throw new RangeError(`Epoch millis out of range: ${self.epochMillis}`);
	let zone;
	if (options?.timeZone === void 0) zone = zoneMakeOffset$1(new Date(self.epochMillis).getTimezoneOffset() * -60 * 1e3);
	else if (isTimeZone(options?.timeZone)) zone = options.timeZone;
	else if (typeof options?.timeZone === "number") zone = zoneMakeOffset$1(options.timeZone);
	else {
		const parsedZone = zoneFromString$1(options.timeZone);
		if (require_Layer.isNone(parsedZone)) throw new require_Layer.IllegalArgumentException(`Invalid time zone: ${options.timeZone}`);
		zone = parsedZone.value;
	}
	if (options?.adjustForTimeZone !== true) return makeZonedProto(self.epochMillis, zone, self.partsUtc);
	return makeZonedFromAdjusted(self.epochMillis, zone, options?.disambiguation ?? "compatible");
};
/** @internal */
var makeZoned = /* @__PURE__ */ require_Layer.liftThrowable(unsafeMakeZoned$1);
var zonedStringRegex = /^(.{17,35})\[(.+)\]$/;
/** @internal */
var makeZonedFromString$1 = (input) => {
	const match = zonedStringRegex.exec(input);
	if (match === null) {
		const offset = parseOffset(input);
		return offset !== null ? makeZoned(input, { timeZone: offset }) : require_Layer.none$1();
	}
	const [, isoString, timeZone] = match;
	return makeZoned(isoString, { timeZone });
};
var validZoneCache = /* @__PURE__ */ require_Layer.globalValue("effect/DateTime/validZoneCache", () => /* @__PURE__ */ new Map());
var formatOptions = {
	day: "numeric",
	month: "numeric",
	year: "numeric",
	hour: "numeric",
	minute: "numeric",
	second: "numeric",
	timeZoneName: "longOffset",
	fractionalSecondDigits: 3,
	hourCycle: "h23"
};
var zoneMakeIntl = (format) => {
	const zoneId = format.resolvedOptions().timeZone;
	if (validZoneCache.has(zoneId)) return validZoneCache.get(zoneId);
	const zone = Object.create(ProtoTimeZoneNamed);
	zone.id = zoneId;
	zone.format = format;
	validZoneCache.set(zoneId, zone);
	return zone;
};
/** @internal */
var zoneUnsafeMakeNamed$1 = (zoneId) => {
	if (validZoneCache.has(zoneId)) return validZoneCache.get(zoneId);
	try {
		return zoneMakeIntl(new Intl.DateTimeFormat("en-US", {
			...formatOptions,
			timeZone: zoneId
		}));
	} catch {
		throw new require_Layer.IllegalArgumentException(`Invalid time zone: ${zoneId}`);
	}
};
/** @internal */
var zoneMakeOffset$1 = (offset) => {
	const zone = Object.create(ProtoTimeZoneOffset);
	zone.offset = offset;
	return zone;
};
/** @internal */
var zoneMakeNamed = /* @__PURE__ */ require_Layer.liftThrowable(zoneUnsafeMakeNamed$1);
var offsetZoneRegex = /^(?:GMT|[+-])/;
/** @internal */
var zoneFromString$1 = (zone) => {
	if (offsetZoneRegex.test(zone)) {
		const offset = parseOffset(zone);
		return offset === null ? require_Layer.none$1() : require_Layer.some(zoneMakeOffset$1(offset));
	}
	return zoneMakeNamed(zone);
};
/** @internal */
var zoneToString$1 = (self) => {
	if (self._tag === "Offset") return offsetToString(self.offset);
	return self.id;
};
/** @internal */
var toDateUtc$1 = (self) => new Date(self.epochMillis);
/** @internal */
var toDate = (self) => {
	if (self._tag === "Utc") return new Date(self.epochMillis);
	else if (self.zone._tag === "Offset") return new Date(self.epochMillis + self.zone.offset);
	else if (self.adjustedEpochMillis !== void 0) return new Date(self.adjustedEpochMillis);
	const parts = self.zone.format.formatToParts(self.epochMillis).filter((_) => _.type !== "literal");
	const date = /* @__PURE__ */ new Date(0);
	date.setUTCFullYear(Number(parts[2].value), Number(parts[0].value) - 1, Number(parts[1].value));
	date.setUTCHours(Number(parts[3].value), Number(parts[4].value), Number(parts[5].value), Number(parts[6].value));
	self.adjustedEpochMillis = date.getTime();
	return date;
};
/** @internal */
var zonedOffset = (self) => {
	return toDate(self).getTime() - toEpochMillis$1(self);
};
var offsetToString = (offset) => {
	const abs = Math.abs(offset);
	let hours = Math.floor(abs / (3600 * 1e3));
	let minutes = Math.round(abs % (3600 * 1e3) / (60 * 1e3));
	if (minutes === 60) {
		hours += 1;
		minutes = 0;
	}
	return `${offset < 0 ? "-" : "+"}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
};
/** @internal */
var zonedOffsetIso = (self) => offsetToString(zonedOffset(self));
/** @internal */
var toEpochMillis$1 = (self) => self.epochMillis;
var setPartsDate = (date, parts) => {
	if (parts.year !== void 0) date.setUTCFullYear(parts.year);
	if (parts.month !== void 0) date.setUTCMonth(parts.month - 1);
	if (parts.day !== void 0) date.setUTCDate(parts.day);
	if (parts.weekDay !== void 0) {
		const diff = parts.weekDay - date.getUTCDay();
		date.setUTCDate(date.getUTCDate() + diff);
	}
	if (parts.hours !== void 0) date.setUTCHours(parts.hours);
	if (parts.minutes !== void 0) date.setUTCMinutes(parts.minutes);
	if (parts.seconds !== void 0) date.setUTCSeconds(parts.seconds);
	if (parts.millis !== void 0) date.setUTCMilliseconds(parts.millis);
};
var constDayMillis = 1440 * 60 * 1e3;
var makeZonedFromAdjusted = (adjustedMillis, zone, disambiguation) => {
	if (zone._tag === "Offset") return makeZonedProto(adjustedMillis - zone.offset, zone);
	const beforeOffset = calculateNamedOffset(adjustedMillis - constDayMillis, adjustedMillis, zone);
	const afterOffset = calculateNamedOffset(adjustedMillis + constDayMillis, adjustedMillis, zone);
	if (beforeOffset === afterOffset) return makeZonedProto(adjustedMillis - beforeOffset, zone);
	const isForwards = beforeOffset < afterOffset;
	const transitionMillis = beforeOffset - afterOffset;
	if (isForwards) {
		if (calculateNamedOffset(adjustedMillis - afterOffset, adjustedMillis, zone) === afterOffset) return makeZonedProto(adjustedMillis - afterOffset, zone);
		const before = makeZonedProto(adjustedMillis - beforeOffset, zone);
		if (adjustedMillis !== toDate(before).getTime()) switch (disambiguation) {
			case "reject": {
				const formatted = new Date(adjustedMillis).toISOString();
				throw new RangeError(`Gap time: ${formatted} does not exist in time zone ${zone.id}`);
			}
			case "earlier": return makeZonedProto(adjustedMillis - afterOffset, zone);
			case "compatible":
			case "later": return before;
		}
		return before;
	}
	if (calculateNamedOffset(adjustedMillis - beforeOffset, adjustedMillis, zone) === beforeOffset) {
		if (disambiguation === "earlier" || disambiguation === "compatible") return makeZonedProto(adjustedMillis - beforeOffset, zone);
		if (calculateNamedOffset(adjustedMillis - beforeOffset + transitionMillis, adjustedMillis + transitionMillis, zone) === beforeOffset) return makeZonedProto(adjustedMillis - beforeOffset, zone);
		if (disambiguation === "reject") {
			const formatted = new Date(adjustedMillis).toISOString();
			throw new RangeError(`Ambiguous time: ${formatted} occurs twice in time zone ${zone.id}`);
		}
	}
	return makeZonedProto(adjustedMillis - afterOffset, zone);
};
var offsetRegex = /([+-])(\d{2}):(\d{2})$/;
var parseOffset = (offset) => {
	const match = offsetRegex.exec(offset);
	if (match === null) return null;
	const [, sign, hours, minutes] = match;
	return (sign === "+" ? 1 : -1) * (Number(hours) * 60 + Number(minutes)) * 60 * 1e3;
};
var calculateNamedOffset = (utcMillis, adjustedMillis, zone) => {
	const offset = zone.format.formatToParts(utcMillis).find((_) => _.type === "timeZoneName")?.value ?? "";
	if (offset === "GMT") return 0;
	const result = parseOffset(offset);
	if (result === null) return zonedOffset(makeZonedProto(adjustedMillis, zone));
	return result;
};
/** @internal */
var formatIso$1 = (self) => toDateUtc$1(self).toISOString();
/** @internal */
var formatIsoOffset = (self) => {
	const date = toDate(self);
	return self._tag === "Utc" ? date.toISOString() : `${date.toISOString().slice(0, -1)}${zonedOffsetIso(self)}`;
};
/** @internal */
var formatIsoZoned$1 = (self) => self.zone._tag === "Offset" ? formatIsoOffset(self) : `${formatIsoOffset(self)}[${self.zone.id}]`;
//#endregion
//#region node_modules/.pnpm/effect@3.21.2/node_modules/effect/dist/esm/String.js
/**
* @example
* ```ts
* import * as assert from "node:assert"
* import { pipe, String } from "effect"
*
* assert.deepStrictEqual(pipe('a', String.toUpperCase), 'A')
* ```
*
* @since 2.0.0
*/
var toUpperCase = (self) => self.toUpperCase();
/**
* @example
* ```ts
* import * as assert from "node:assert"
* import { pipe, String } from "effect"
*
* assert.deepStrictEqual(pipe('A', String.toLowerCase), 'a')
* ```
*
* @since 2.0.0
*/
var toLowerCase = (self) => self.toLowerCase();
/**
* @example
* ```ts
* import * as assert from "node:assert"
* import { pipe, String } from "effect"
*
* assert.deepStrictEqual(pipe('abc', String.capitalize), 'Abc')
* ```
*
* @since 2.0.0
*/
var capitalize = (self) => {
	if (self.length === 0) return self;
	return toUpperCase(self[0]) + self.slice(1);
};
/**
* @example
* ```ts
* import * as assert from "node:assert"
* import { pipe, String } from "effect"
*
* assert.deepStrictEqual(pipe('ABC', String.uncapitalize), 'aBC')
* ```
*
* @since 2.0.0
*/
var uncapitalize = (self) => {
	if (self.length === 0) return self;
	return toLowerCase(self[0]) + self.slice(1);
};
/**
* Test whether a `string` is non empty.
*
* @since 2.0.0
*/
var isNonEmpty = (self) => self.length > 0;
//#endregion
//#region node_modules/.pnpm/effect@3.21.2/node_modules/effect/dist/esm/DateTime.js
/**
* @since 3.6.0
* @category guards
*/
var isDateTime = isDateTime$1;
/**
* @since 3.6.0
* @category guards
*/
var isTimeZoneOffset = isTimeZoneOffset$1;
/**
* @since 3.6.0
* @category guards
*/
var isTimeZoneNamed = isTimeZoneNamed$1;
/**
* @since 3.6.0
* @category guards
*/
var isUtc = isUtc$1;
/**
* @since 3.6.0
* @category guards
*/
var isZoned = isZoned$1;
/**
* @since 3.6.0
* @category instances
*/
var Equivalence = Equivalence$1;
/**
* Create a `DateTime` from a `Date`.
*
* If the `Date` is invalid, an `IllegalArgumentException` will be thrown.
*
* @since 3.6.0
* @category constructors
*/
var unsafeFromDate = unsafeFromDate$1;
/**
* Create a `DateTime` from one of the following:
*
* - A `DateTime`
* - A `Date` instance (invalid dates will throw an `IllegalArgumentException`)
* - The `number` of milliseconds since the Unix epoch
* - An object with the parts of a date
* - A `string` that can be parsed by `Date.parse`
*
* @since 3.6.0
* @category constructors
* @example
* ```ts
* import { DateTime } from "effect"
*
* // from Date
* DateTime.unsafeMake(new Date())
*
* // from parts
* DateTime.unsafeMake({ year: 2024 })
*
* // from string
* DateTime.unsafeMake("2024-01-01")
* ```
*/
var unsafeMake = unsafeMake$1;
/**
* Create a `DateTime.Zoned` using `DateTime.unsafeMake` and a time zone.
*
* The input is treated as UTC and then the time zone is attached, unless
* `adjustForTimeZone` is set to `true`. In that case, the input is treated as
* already in the time zone.
*
* When `adjustForTimeZone` is true and ambiguous times occur during DST transitions,
* the `disambiguation` option controls how to resolve the ambiguity:
* - `compatible` (default): Choose earlier time for repeated times, later for gaps
* - `earlier`: Always choose the earlier of two possible times
* - `later`: Always choose the later of two possible times
* - `reject`: Throw an error when ambiguous times are encountered
*
* @since 3.6.0
* @category constructors
* @example
* ```ts
* import { DateTime } from "effect"
*
* DateTime.unsafeMakeZoned(new Date(), { timeZone: "Europe/London" })
* ```
*/
var unsafeMakeZoned = unsafeMakeZoned$1;
/**
* Create a `DateTime.Zoned` from a string.
*
* It uses the format: `YYYY-MM-DDTHH:mm:ss.sss+HH:MM[Time/Zone]`.
*
* @since 3.6.0
* @category constructors
*/
var makeZonedFromString = makeZonedFromString$1;
/**
* Attempt to create a named time zone from a IANA time zone identifier.
*
* If the time zone is invalid, an `IllegalArgumentException` will be thrown.
*
* @since 3.6.0
* @category time zones
*/
var zoneUnsafeMakeNamed = zoneUnsafeMakeNamed$1;
/**
* Create a fixed offset time zone.
*
* @since 3.6.0
* @category time zones
*/
var zoneMakeOffset = zoneMakeOffset$1;
/**
* Try parse a TimeZone from a string
*
* @since 3.6.0
* @category time zones
*/
var zoneFromString = zoneFromString$1;
/**
* Format a `TimeZone` as a string.
*
* @since 3.6.0
* @category time zones
* @example
* ```ts
* import { DateTime, Effect } from "effect"
*
* // Outputs "+03:00"
* DateTime.zoneToString(DateTime.zoneMakeOffset(3 * 60 * 60 * 1000))
*
* // Outputs "Europe/London"
* DateTime.zoneToString(DateTime.zoneUnsafeMakeNamed("Europe/London"))
* ```
*/
var zoneToString = zoneToString$1;
/**
* Get the UTC `Date` of a `DateTime`.
*
* @since 3.6.0
* @category conversions
*/
var toDateUtc = toDateUtc$1;
/**
* Get the milliseconds since the Unix epoch of a `DateTime`.
*
* @since 3.6.0
* @category conversions
*/
var toEpochMillis = toEpochMillis$1;
require_Layer.Tag("effect/DateTime/CurrentTimeZone")();
/**
* Format a `DateTime` as a UTC ISO string.
*
* @since 3.6.0
* @category formatting
*/
var formatIso = formatIso$1;
/**
* Format a `DateTime.Zoned` as a string.
*
* It uses the format: `YYYY-MM-DDTHH:mm:ss.sss+HH:MM[Time/Zone]`.
*
* @since 3.6.0
* @category formatting
*/
var formatIsoZoned = formatIsoZoned$1;
//#endregion
//#region node_modules/.pnpm/effect@3.21.2/node_modules/effect/dist/esm/ParseResult.js
/**
* @since 3.10.0
*/
/**
* @category model
* @since 3.10.0
*/
var Pointer = class {
	path;
	actual;
	issue;
	/**
	* @since 3.10.0
	*/
	_tag = "Pointer";
	constructor(path, actual, issue) {
		this.path = path;
		this.actual = actual;
		this.issue = issue;
	}
};
/**
* Error that occurs when an unexpected key or index is present.
*
* @category model
* @since 3.10.0
*/
var Unexpected = class {
	actual;
	message;
	/**
	* @since 3.10.0
	*/
	_tag = "Unexpected";
	constructor(actual, message) {
		this.actual = actual;
		this.message = message;
	}
};
/**
* Error that occurs when a required key or index is missing.
*
* @category model
* @since 3.10.0
*/
var Missing = class {
	ast;
	message;
	/**
	* @since 3.10.0
	*/
	_tag = "Missing";
	/**
	* @since 3.10.0
	*/
	actual = void 0;
	constructor(ast, message) {
		this.ast = ast;
		this.message = message;
	}
};
/**
* Error that contains multiple issues.
*
* @category model
* @since 3.10.0
*/
var Composite = class {
	ast;
	actual;
	issues;
	output;
	/**
	* @since 3.10.0
	*/
	_tag = "Composite";
	constructor(ast, actual, issues, output) {
		this.ast = ast;
		this.actual = actual;
		this.issues = issues;
		this.output = output;
	}
};
/**
* Error that occurs when a refinement has an error.
*
* @category model
* @since 3.10.0
*/
var Refinement = class {
	ast;
	actual;
	kind;
	issue;
	/**
	* @since 3.10.0
	*/
	_tag = "Refinement";
	constructor(ast, actual, kind, issue) {
		this.ast = ast;
		this.actual = actual;
		this.kind = kind;
		this.issue = issue;
	}
};
/**
* Error that occurs when a transformation has an error.
*
* @category model
* @since 3.10.0
*/
var Transformation = class {
	ast;
	actual;
	kind;
	issue;
	/**
	* @since 3.10.0
	*/
	_tag = "Transformation";
	constructor(ast, actual, kind, issue) {
		this.ast = ast;
		this.actual = actual;
		this.kind = kind;
		this.issue = issue;
	}
};
/**
* The `Type` variant of the `ParseIssue` type represents an error that occurs when the `actual` value is not of the expected type.
* The `ast` field specifies the expected type, and the `actual` field contains the value that caused the error.
*
* @category model
* @since 3.10.0
*/
var Type = class {
	ast;
	actual;
	message;
	/**
	* @since 3.10.0
	*/
	_tag = "Type";
	constructor(ast, actual, message) {
		this.ast = ast;
		this.actual = actual;
		this.message = message;
	}
};
/**
* The `Forbidden` variant of the `ParseIssue` type represents a forbidden operation, such as when encountering an Effect that is not allowed to execute (e.g., using `runSync`).
*
* @category model
* @since 3.10.0
*/
var Forbidden = class {
	ast;
	actual;
	message;
	/**
	* @since 3.10.0
	*/
	_tag = "Forbidden";
	constructor(ast, actual, message) {
		this.ast = ast;
		this.actual = actual;
		this.message = message;
	}
};
/**
* @category type id
* @since 3.10.0
*/
var ParseErrorTypeId = /* @__PURE__ */ Symbol.for("effect/Schema/ParseErrorTypeId");
/**
* @since 3.10.0
*/
var ParseError = class extends TaggedError("ParseError") {
	/**
	* @since 3.10.0
	*/
	[ParseErrorTypeId] = ParseErrorTypeId;
	get message() {
		return this.toString();
	}
	/**
	* @since 3.10.0
	*/
	toString() {
		return TreeFormatter.formatIssueSync(this.issue);
	}
	/**
	* @since 3.10.0
	*/
	toJSON() {
		return {
			_id: "ParseError",
			message: this.toString()
		};
	}
	/**
	* @since 3.10.0
	*/
	[require_Layer.NodeInspectSymbol]() {
		return this.toJSON();
	}
};
/**
* @category constructors
* @since 3.10.0
*/
var parseError = (issue) => new ParseError({ issue });
/**
* @category constructors
* @since 3.10.0
*/
var succeed = require_Layer.right;
/**
* @category constructors
* @since 3.10.0
*/
var fail = require_Layer.left;
var _try = require_Layer.try_$1;
/**
* @category constructors
* @since 3.10.0
*/
var fromOption = require_Layer.fromOption;
var isEither = require_Layer.isEither;
/**
* @category optimisation
* @since 3.10.0
*/
var flatMap = /* @__PURE__ */ require_Layer.dual(2, (self, f) => {
	return isEither(self) ? require_Layer.match$1(self, {
		onLeft: require_Layer.left,
		onRight: f
	}) : require_Layer.flatMap(self, f);
});
/**
* @category optimisation
* @since 3.10.0
*/
var map = /* @__PURE__ */ require_Layer.dual(2, (self, f) => {
	return isEither(self) ? require_Layer.map$2(self, f) : require_Layer.map(self, f);
});
/**
* @category optimisation
* @since 3.10.0
*/
var mapError = /* @__PURE__ */ require_Layer.dual(2, (self, f) => {
	return isEither(self) ? require_Layer.mapLeft(self, f) : require_Layer.mapError(self, f);
});
/**
* @category optimisation
* @since 3.10.0
*/
var mapBoth = /* @__PURE__ */ require_Layer.dual(2, (self, options) => {
	return isEither(self) ? require_Layer.mapBoth$1(self, {
		onLeft: options.onFailure,
		onRight: options.onSuccess
	}) : require_Layer.mapBoth(self, options);
});
/**
* @category optimisation
* @since 3.10.0
*/
var orElse = /* @__PURE__ */ require_Layer.dual(2, (self, f) => {
	return isEither(self) ? require_Layer.match$1(self, {
		onLeft: f,
		onRight: require_Layer.right
	}) : require_Layer.catchAll(self, f);
});
/** @internal */
var mergeInternalOptions = (options, overrideOptions) => {
	if (overrideOptions === void 0 || require_Layer.isNumber(overrideOptions)) return options;
	if (options === void 0) return overrideOptions;
	return {
		...options,
		...overrideOptions
	};
};
var getEither = (ast, isDecoding, options) => {
	const parser = goMemo(ast, isDecoding);
	return (u, overrideOptions) => parser(u, mergeInternalOptions(options, overrideOptions));
};
var getSync = (ast, isDecoding, options) => {
	const parser = getEither(ast, isDecoding, options);
	return (input, overrideOptions) => require_Layer.getOrThrowWith$1(parser(input, overrideOptions), parseError);
};
var getEffect = (ast, isDecoding, options) => {
	const parser = goMemo(ast, isDecoding);
	return (input, overrideOptions) => parser(input, {
		...mergeInternalOptions(options, overrideOptions),
		isEffectAllowed: true
	});
};
/**
* @category decoding
* @since 3.10.0
*/
var decodeUnknownEither$1 = (schema, options) => getEither(schema.ast, true, options);
/**
* @category decoding
* @since 3.10.0
*/
var decodeUnknown = (schema, options) => getEffect(schema.ast, true, options);
/**
* @category encoding
* @since 3.10.0
*/
var encodeUnknown = (schema, options) => getEffect(schema.ast, false, options);
/**
* @throws `ParseError`
* @category validation
* @since 3.10.0
*/
var validateSync = (schema, options) => getSync(typeAST(schema.ast), true, options);
var decodeMemoMap = /* @__PURE__ */ require_Layer.globalValue(/* @__PURE__ */ Symbol.for("effect/ParseResult/decodeMemoMap"), () => /* @__PURE__ */ new WeakMap());
var encodeMemoMap = /* @__PURE__ */ require_Layer.globalValue(/* @__PURE__ */ Symbol.for("effect/ParseResult/encodeMemoMap"), () => /* @__PURE__ */ new WeakMap());
var goMemo = (ast, isDecoding) => {
	const memoMap = isDecoding ? decodeMemoMap : encodeMemoMap;
	const memo = memoMap.get(ast);
	if (memo) return memo;
	const raw = go(ast, isDecoding);
	const parseOptionsAnnotation = getParseOptionsAnnotation(ast);
	const parserWithOptions = require_Layer.isSome(parseOptionsAnnotation) ? (i, options) => raw(i, mergeInternalOptions(options, parseOptionsAnnotation.value)) : raw;
	const decodingFallbackAnnotation = getDecodingFallbackAnnotation(ast);
	const parser = isDecoding && require_Layer.isSome(decodingFallbackAnnotation) ? (i, options) => handleForbidden(orElse(parserWithOptions(i, options), decodingFallbackAnnotation.value), ast, i, options) : parserWithOptions;
	memoMap.set(ast, parser);
	return parser;
};
var getConcurrency = (ast) => require_Layer.getOrUndefined(getConcurrencyAnnotation(ast));
var getBatching = (ast) => require_Layer.getOrUndefined(getBatchingAnnotation(ast));
var go = (ast, isDecoding) => {
	switch (ast._tag) {
		case "Refinement": if (isDecoding) {
			const from = goMemo(ast.from, true);
			return (i, options) => {
				options = options ?? defaultParseOption;
				const allErrors = options?.errors === "all";
				return handleForbidden(flatMap(orElse(from(i, options), (ef) => {
					const issue = new Refinement(ast, i, "From", ef);
					if (allErrors && hasStableFilter(ast) && isComposite(ef)) return require_Layer.match(ast.filter(i, options, ast), {
						onNone: () => require_Layer.left(issue),
						onSome: (ep) => require_Layer.left(new Composite(ast, i, [issue, new Refinement(ast, i, "Predicate", ep)]))
					});
					return require_Layer.left(issue);
				}), (a) => require_Layer.match(ast.filter(a, options, ast), {
					onNone: () => require_Layer.right(a),
					onSome: (ep) => require_Layer.left(new Refinement(ast, i, "Predicate", ep))
				})), ast, i, options);
			};
		} else {
			const from = goMemo(typeAST(ast), true);
			const to = goMemo(dropRightRefinement(ast.from), false);
			return (i, options) => handleForbidden(flatMap(from(i, options), (a) => to(a, options)), ast, i, options);
		}
		case "Transformation": {
			const transform = getFinalTransformation(ast.transformation, isDecoding);
			const from = isDecoding ? goMemo(ast.from, true) : goMemo(ast.to, false);
			const to = isDecoding ? goMemo(ast.to, true) : goMemo(ast.from, false);
			return (i, options) => handleForbidden(flatMap(mapError(from(i, options), (e) => new Transformation(ast, i, isDecoding ? "Encoded" : "Type", e)), (a) => flatMap(mapError(transform(a, options ?? defaultParseOption, ast, i), (e) => new Transformation(ast, i, "Transformation", e)), (i2) => mapError(to(i2, options), (e) => new Transformation(ast, i, isDecoding ? "Type" : "Encoded", e)))), ast, i, options);
		}
		case "Declaration": {
			const parse = isDecoding ? ast.decodeUnknown(...ast.typeParameters) : ast.encodeUnknown(...ast.typeParameters);
			return (i, options) => handleForbidden(parse(i, options ?? defaultParseOption, ast), ast, i, options);
		}
		case "Literal": return fromRefinement(ast, (u) => u === ast.literal);
		case "UniqueSymbol": return fromRefinement(ast, (u) => u === ast.symbol);
		case "UndefinedKeyword": return fromRefinement(ast, require_Layer.isUndefined);
		case "NeverKeyword": return fromRefinement(ast, require_Layer.isNever);
		case "UnknownKeyword":
		case "AnyKeyword":
		case "VoidKeyword": return require_Layer.right;
		case "StringKeyword": return fromRefinement(ast, require_Layer.isString);
		case "NumberKeyword": return fromRefinement(ast, require_Layer.isNumber);
		case "BooleanKeyword": return fromRefinement(ast, require_Layer.isBoolean);
		case "BigIntKeyword": return fromRefinement(ast, require_Layer.isBigInt);
		case "SymbolKeyword": return fromRefinement(ast, require_Layer.isSymbol);
		case "ObjectKeyword": return fromRefinement(ast, require_Layer.isObject);
		case "Enums": return fromRefinement(ast, (u) => ast.enums.some(([_, value]) => value === u));
		case "TemplateLiteral": {
			const regex = getTemplateLiteralRegExp(ast);
			return fromRefinement(ast, (u) => require_Layer.isString(u) && regex.test(u));
		}
		case "TupleType": {
			const elements = ast.elements.map((e) => goMemo(e.type, isDecoding));
			const rest = ast.rest.map((annotatedAST) => goMemo(annotatedAST.type, isDecoding));
			let requiredTypes = ast.elements.filter((e) => !e.isOptional);
			if (ast.rest.length > 0) requiredTypes = requiredTypes.concat(ast.rest.slice(1));
			const requiredLen = requiredTypes.length;
			const expectedIndexes = ast.elements.length > 0 ? ast.elements.map((_, i) => i).join(" | ") : "never";
			const concurrency = getConcurrency(ast);
			const batching = getBatching(ast);
			return (input, options) => {
				if (!require_Layer.isArray(input)) return require_Layer.left(new Type(ast, input));
				const allErrors = options?.errors === "all";
				const es = [];
				let stepKey = 0;
				const output = [];
				const len = input.length;
				for (let i = len; i <= requiredLen - 1; i++) {
					const e = new Pointer(i, input, new Missing(requiredTypes[i - len]));
					if (allErrors) {
						es.push([stepKey++, e]);
						continue;
					} else return require_Layer.left(new Composite(ast, input, e, output));
				}
				if (ast.rest.length === 0) for (let i = ast.elements.length; i <= len - 1; i++) {
					const e = new Pointer(i, input, new Unexpected(input[i], `is unexpected, expected: ${expectedIndexes}`));
					if (allErrors) {
						es.push([stepKey++, e]);
						continue;
					} else return require_Layer.left(new Composite(ast, input, e, output));
				}
				let i = 0;
				let queue = void 0;
				for (; i < elements.length; i++) if (len < i + 1) {
					if (ast.elements[i].isOptional) continue;
				} else {
					const parser = elements[i];
					const te = parser(input[i], options);
					if (isEither(te)) {
						if (require_Layer.isLeft(te)) {
							const e = new Pointer(i, input, te.left);
							if (allErrors) {
								es.push([stepKey++, e]);
								continue;
							} else return require_Layer.left(new Composite(ast, input, e, sortByIndex(output)));
						}
						output.push([stepKey++, te.right]);
					} else {
						const nk = stepKey++;
						const index = i;
						if (!queue) queue = [];
						queue.push(({ es, output }) => require_Layer.flatMap(require_Layer.either(te), (t) => {
							if (require_Layer.isLeft(t)) {
								const e = new Pointer(index, input, t.left);
								if (allErrors) {
									es.push([nk, e]);
									return require_Layer._void;
								} else return require_Layer.left(new Composite(ast, input, e, sortByIndex(output)));
							}
							output.push([nk, t.right]);
							return require_Layer._void;
						}));
					}
				}
				if (require_Layer.isNonEmptyReadonlyArray(rest)) {
					const [head, ...tail] = rest;
					for (; i < len - tail.length; i++) {
						const te = head(input[i], options);
						if (isEither(te)) if (require_Layer.isLeft(te)) {
							const e = new Pointer(i, input, te.left);
							if (allErrors) {
								es.push([stepKey++, e]);
								continue;
							} else return require_Layer.left(new Composite(ast, input, e, sortByIndex(output)));
						} else output.push([stepKey++, te.right]);
						else {
							const nk = stepKey++;
							const index = i;
							if (!queue) queue = [];
							queue.push(({ es, output }) => require_Layer.flatMap(require_Layer.either(te), (t) => {
								if (require_Layer.isLeft(t)) {
									const e = new Pointer(index, input, t.left);
									if (allErrors) {
										es.push([nk, e]);
										return require_Layer._void;
									} else return require_Layer.left(new Composite(ast, input, e, sortByIndex(output)));
								} else {
									output.push([nk, t.right]);
									return require_Layer._void;
								}
							}));
						}
					}
					for (let j = 0; j < tail.length; j++) {
						const index = i + j;
						if (len < index + 1) continue;
						else {
							const te = tail[j](input[index], options);
							if (isEither(te)) {
								if (require_Layer.isLeft(te)) {
									const e = new Pointer(index, input, te.left);
									if (allErrors) {
										es.push([stepKey++, e]);
										continue;
									} else return require_Layer.left(new Composite(ast, input, e, sortByIndex(output)));
								}
								output.push([stepKey++, te.right]);
							} else {
								const nk = stepKey++;
								if (!queue) queue = [];
								queue.push(({ es, output }) => require_Layer.flatMap(require_Layer.either(te), (t) => {
									if (require_Layer.isLeft(t)) {
										const e = new Pointer(index, input, t.left);
										if (allErrors) {
											es.push([nk, e]);
											return require_Layer._void;
										} else return require_Layer.left(new Composite(ast, input, e, sortByIndex(output)));
									}
									output.push([nk, t.right]);
									return require_Layer._void;
								}));
							}
						}
					}
				}
				const computeResult = ({ es, output }) => require_Layer.isNonEmptyArray(es) ? require_Layer.left(new Composite(ast, input, sortByIndex(es), sortByIndex(output))) : require_Layer.right(sortByIndex(output));
				if (queue && queue.length > 0) {
					const cqueue = queue;
					return require_Layer.suspend(() => {
						const state = {
							es: require_Layer.copy(es),
							output: require_Layer.copy(output)
						};
						return require_Layer.flatMap(require_Layer.forEach(cqueue, (f) => f(state), {
							concurrency,
							batching,
							discard: true
						}), () => computeResult(state));
					});
				}
				return computeResult({
					output,
					es
				});
			};
		}
		case "TypeLiteral": {
			if (ast.propertySignatures.length === 0 && ast.indexSignatures.length === 0) return fromRefinement(ast, require_Layer.isNotNullable);
			const propertySignatures = [];
			const expectedKeysMap = {};
			const expectedKeys = [];
			for (const ps of ast.propertySignatures) {
				propertySignatures.push([goMemo(ps.type, isDecoding), ps]);
				expectedKeysMap[ps.name] = null;
				expectedKeys.push(ps.name);
			}
			const indexSignatures = ast.indexSignatures.map((is) => [
				goMemo(is.parameter, isDecoding),
				goMemo(is.type, isDecoding),
				is.parameter
			]);
			const expectedAST = Union$1.make(ast.indexSignatures.map((is) => is.parameter).concat(expectedKeys.map((key) => require_Layer.isSymbol(key) ? new UniqueSymbol(key) : new Literal$1(key))));
			const expected = goMemo(expectedAST, isDecoding);
			const concurrency = getConcurrency(ast);
			const batching = getBatching(ast);
			return (input, options) => {
				if (!require_Layer.isRecord(input)) return require_Layer.left(new Type(ast, input));
				const allErrors = options?.errors === "all";
				const es = [];
				let stepKey = 0;
				const onExcessPropertyError = options?.onExcessProperty === "error";
				const onExcessPropertyPreserve = options?.onExcessProperty === "preserve";
				const output = {};
				let inputKeys;
				if (onExcessPropertyError || onExcessPropertyPreserve) {
					inputKeys = Reflect.ownKeys(input);
					for (const key of inputKeys) {
						const te = expected(key, options);
						if (isEither(te) && require_Layer.isLeft(te)) if (onExcessPropertyError) {
							const e = new Pointer(key, input, new Unexpected(input[key], `is unexpected, expected: ${String(expectedAST)}`));
							if (allErrors) {
								es.push([stepKey++, e]);
								continue;
							} else return require_Layer.left(new Composite(ast, input, e, output));
						} else output[key] = input[key];
					}
				}
				let queue = void 0;
				const isExact = options?.exact === true;
				for (let i = 0; i < propertySignatures.length; i++) {
					const ps = propertySignatures[i][1];
					const name = ps.name;
					const hasKey = Object.prototype.hasOwnProperty.call(input, name);
					if (!hasKey) {
						if (ps.isOptional) continue;
						else if (isExact) {
							const e = new Pointer(name, input, new Missing(ps));
							if (allErrors) {
								es.push([stepKey++, e]);
								continue;
							} else return require_Layer.left(new Composite(ast, input, e, output));
						}
					}
					const parser = propertySignatures[i][0];
					const te = parser(input[name], options);
					if (isEither(te)) {
						if (require_Layer.isLeft(te)) {
							const e = new Pointer(name, input, hasKey ? te.left : new Missing(ps));
							if (allErrors) {
								es.push([stepKey++, e]);
								continue;
							} else return require_Layer.left(new Composite(ast, input, e, output));
						}
						output[name] = te.right;
					} else {
						const nk = stepKey++;
						const index = name;
						if (!queue) queue = [];
						queue.push(({ es, output }) => require_Layer.flatMap(require_Layer.either(te), (t) => {
							if (require_Layer.isLeft(t)) {
								const e = new Pointer(index, input, hasKey ? t.left : new Missing(ps));
								if (allErrors) {
									es.push([nk, e]);
									return require_Layer._void;
								} else return require_Layer.left(new Composite(ast, input, e, output));
							}
							output[index] = t.right;
							return require_Layer._void;
						}));
					}
				}
				for (let i = 0; i < indexSignatures.length; i++) {
					const indexSignature = indexSignatures[i];
					const parameter = indexSignature[0];
					const type = indexSignature[1];
					const keys = getKeysForIndexSignature(input, indexSignature[2]);
					for (const key of keys) {
						const keu = parameter(key, options);
						if (isEither(keu) && require_Layer.isRight(keu)) {
							const vpr = type(input[key], options);
							if (isEither(vpr)) {
								if (require_Layer.isLeft(vpr)) {
									const e = new Pointer(key, input, vpr.left);
									if (allErrors) {
										es.push([stepKey++, e]);
										continue;
									} else return require_Layer.left(new Composite(ast, input, e, output));
								} else if (!Object.prototype.hasOwnProperty.call(expectedKeysMap, key)) output[key] = vpr.right;
							} else {
								const nk = stepKey++;
								const index = key;
								if (!queue) queue = [];
								queue.push(({ es, output }) => require_Layer.flatMap(require_Layer.either(vpr), (tv) => {
									if (require_Layer.isLeft(tv)) {
										const e = new Pointer(index, input, tv.left);
										if (allErrors) {
											es.push([nk, e]);
											return require_Layer._void;
										} else return require_Layer.left(new Composite(ast, input, e, output));
									} else {
										if (!Object.prototype.hasOwnProperty.call(expectedKeysMap, key)) output[key] = tv.right;
										return require_Layer._void;
									}
								}));
							}
						}
					}
				}
				const computeResult = ({ es, output }) => {
					if (require_Layer.isNonEmptyArray(es)) return require_Layer.left(new Composite(ast, input, sortByIndex(es), output));
					if (options?.propertyOrder === "original") {
						const keys = inputKeys || Reflect.ownKeys(input);
						for (const name of expectedKeys) if (keys.indexOf(name) === -1) keys.push(name);
						const out = {};
						for (const key of keys) if (Object.prototype.hasOwnProperty.call(output, key)) out[key] = output[key];
						return require_Layer.right(out);
					}
					return require_Layer.right(output);
				};
				if (queue && queue.length > 0) {
					const cqueue = queue;
					return require_Layer.suspend(() => {
						const state = {
							es: require_Layer.copy(es),
							output: Object.assign({}, output)
						};
						return require_Layer.flatMap(require_Layer.forEach(cqueue, (f) => f(state), {
							concurrency,
							batching,
							discard: true
						}), () => computeResult(state));
					});
				}
				return computeResult({
					es,
					output
				});
			};
		}
		case "Union": {
			const searchTree = getSearchTree(ast.types, isDecoding);
			const ownKeys = Reflect.ownKeys(searchTree.keys);
			const ownKeysLen = ownKeys.length;
			const astTypesLen = ast.types.length;
			const map = /* @__PURE__ */ new Map();
			for (let i = 0; i < astTypesLen; i++) map.set(ast.types[i], goMemo(ast.types[i], isDecoding));
			const concurrency = getConcurrency(ast) ?? 1;
			const batching = getBatching(ast);
			return (input, options) => {
				const es = [];
				let stepKey = 0;
				let candidates = [];
				if (ownKeysLen > 0) if (require_Layer.isRecordOrArray(input)) for (let i = 0; i < ownKeysLen; i++) {
					const name = ownKeys[i];
					const buckets = searchTree.keys[name].buckets;
					if (Object.prototype.hasOwnProperty.call(input, name)) {
						const literal = String(input[name]);
						if (Object.prototype.hasOwnProperty.call(buckets, literal)) candidates = candidates.concat(buckets[literal]);
						else {
							const { candidates, literals } = searchTree.keys[name];
							const literalsUnion = Union$1.make(literals);
							const errorAst = candidates.length === astTypesLen ? new TypeLiteral([new PropertySignature(name, literalsUnion, false, true)], []) : Union$1.make(candidates);
							es.push([stepKey++, new Composite(errorAst, input, new Pointer(name, input, new Type(literalsUnion, input[name])))]);
						}
					} else {
						const { candidates, literals } = searchTree.keys[name];
						const fakePropertySignature = new PropertySignature(name, Union$1.make(literals), false, true);
						const errorAst = candidates.length === astTypesLen ? new TypeLiteral([fakePropertySignature], []) : Union$1.make(candidates);
						es.push([stepKey++, new Composite(errorAst, input, new Pointer(name, input, new Missing(fakePropertySignature)))]);
					}
				}
				else {
					const errorAst = searchTree.candidates.length === astTypesLen ? ast : Union$1.make(searchTree.candidates);
					es.push([stepKey++, new Type(errorAst, input)]);
				}
				if (searchTree.otherwise.length > 0) candidates = candidates.concat(searchTree.otherwise);
				let queue = void 0;
				for (let i = 0; i < candidates.length; i++) {
					const candidate = candidates[i];
					const pr = map.get(candidate)(input, options);
					if (isEither(pr) && (!queue || queue.length === 0)) if (require_Layer.isRight(pr)) return pr;
					else es.push([stepKey++, pr.left]);
					else {
						const nk = stepKey++;
						if (!queue) queue = [];
						queue.push((state) => require_Layer.suspend(() => {
							if ("finalResult" in state) return require_Layer._void;
							else return require_Layer.flatMap(require_Layer.either(pr), (t) => {
								if (require_Layer.isRight(t)) state.finalResult = t;
								else state.es.push([nk, t.left]);
								return require_Layer._void;
							});
						}));
					}
				}
				const computeResult = (es) => require_Layer.isNonEmptyArray(es) ? es.length === 1 && es[0][1]._tag === "Type" ? require_Layer.left(es[0][1]) : require_Layer.left(new Composite(ast, input, sortByIndex(es))) : require_Layer.left(new Type(ast, input));
				if (queue && queue.length > 0) {
					const cqueue = queue;
					return require_Layer.suspend(() => {
						const state = { es: require_Layer.copy(es) };
						return require_Layer.flatMap(require_Layer.forEach(cqueue, (f) => f(state), {
							concurrency,
							batching,
							discard: true
						}), () => {
							if ("finalResult" in state) return state.finalResult;
							return computeResult(state.es);
						});
					});
				}
				return computeResult(es);
			};
		}
		case "Suspend": {
			const get = memoizeThunk(() => goMemo(ast.f(), isDecoding));
			return (a, options) => get()(a, options);
		}
	}
};
var fromRefinement = (ast, refinement) => (u) => refinement(u) ? require_Layer.right(u) : require_Layer.left(new Type(ast, u));
/** @internal */
var getLiterals = (ast, isDecoding) => {
	switch (ast._tag) {
		case "Declaration": {
			const annotation = getSurrogateAnnotation(ast);
			if (require_Layer.isSome(annotation)) return getLiterals(annotation.value, isDecoding);
			break;
		}
		case "TypeLiteral": {
			const out = [];
			for (let i = 0; i < ast.propertySignatures.length; i++) {
				const propertySignature = ast.propertySignatures[i];
				const type = isDecoding ? encodedAST(propertySignature.type) : typeAST(propertySignature.type);
				if (isLiteral(type) && !propertySignature.isOptional) out.push([propertySignature.name, type]);
			}
			return out;
		}
		case "TupleType": {
			const out = [];
			for (let i = 0; i < ast.elements.length; i++) {
				const element = ast.elements[i];
				const type = isDecoding ? encodedAST(element.type) : typeAST(element.type);
				if (isLiteral(type) && !element.isOptional) out.push([i, type]);
			}
			return out;
		}
		case "Refinement": return getLiterals(ast.from, isDecoding);
		case "Suspend": return getLiterals(ast.f(), isDecoding);
		case "Transformation": return getLiterals(isDecoding ? ast.from : ast.to, isDecoding);
	}
	return [];
};
/**
* The purpose of the algorithm is to narrow down the pool of possible
* candidates for decoding as much as possible.
*
* This function separates the schemas into two groups, `keys` and `otherwise`:
*
* - `keys`: the schema has at least one property with a literal value
* - `otherwise`: the schema has no properties with a literal value
*
* If a schema has at least one property with a literal value, so it ends up in
* `keys`, first a namespace is created for the name of the property containing
* the literal, and then within this namespace a "bucket" is created for the
* literal value in which to store all the schemas that have the same property
* and literal value.
*
* @internal
*/
var getSearchTree = (members, isDecoding) => {
	const keys = {};
	const otherwise = [];
	const candidates = [];
	for (let i = 0; i < members.length; i++) {
		const member = members[i];
		const tags = getLiterals(member, isDecoding);
		if (tags.length > 0) {
			candidates.push(member);
			for (let j = 0; j < tags.length; j++) {
				const [key, literal] = tags[j];
				const hash = String(literal.literal);
				keys[key] = keys[key] || {
					buckets: {},
					literals: [],
					candidates: []
				};
				const buckets = keys[key].buckets;
				if (Object.prototype.hasOwnProperty.call(buckets, hash)) {
					if (j < tags.length - 1) continue;
					buckets[hash].push(member);
					keys[key].literals.push(literal);
					keys[key].candidates.push(member);
				} else {
					buckets[hash] = [member];
					keys[key].literals.push(literal);
					keys[key].candidates.push(member);
					break;
				}
			}
		} else otherwise.push(member);
	}
	return {
		keys,
		otherwise,
		candidates
	};
};
var dropRightRefinement = (ast) => isRefinement$1(ast) ? dropRightRefinement(ast.from) : ast;
var handleForbidden = (effect, ast, actual, options) => {
	if (options?.isEffectAllowed === true) return effect;
	if (isEither(effect)) return effect;
	const scheduler = new require_Layer.SyncScheduler();
	const fiber = require_Layer.runFork(effect, { scheduler });
	scheduler.flush();
	const exit = fiber.unsafePoll();
	if (exit) {
		if (require_Layer.isSuccess(exit)) return require_Layer.right(exit.value);
		const cause = exit.cause;
		if (require_Layer.isFailType(cause)) return require_Layer.left(cause.error);
		return require_Layer.left(new Forbidden(ast, actual, require_Layer.pretty(cause)));
	}
	return require_Layer.left(new Forbidden(ast, actual, "cannot be be resolved synchronously, this is caused by using runSync on an effect that performs async work"));
};
var compare = ([a], [b]) => a > b ? 1 : a < b ? -1 : 0;
function sortByIndex(es) {
	return es.sort(compare).map((t) => t[1]);
}
/** @internal */
var getFinalTransformation = (transformation, isDecoding) => {
	switch (transformation._tag) {
		case "FinalTransformation": return isDecoding ? transformation.decode : transformation.encode;
		case "ComposeTransformation": return require_Layer.right;
		case "TypeLiteralTransformation": return (input) => {
			let out = require_Layer.right(input);
			for (const pst of transformation.propertySignatureTransformations) {
				const [from, to] = isDecoding ? [pst.from, pst.to] : [pst.to, pst.from];
				const transformation = isDecoding ? pst.decode : pst.encode;
				const f = (input) => {
					const o = transformation(Object.prototype.hasOwnProperty.call(input, from) ? require_Layer.some(input[from]) : require_Layer.none$1());
					delete input[from];
					if (require_Layer.isSome(o)) input[to] = o.value;
					return input;
				};
				out = map(out, f);
			}
			return out;
		};
	}
};
var makeTree = (value, forest = []) => ({
	value,
	forest
});
/**
* @category formatting
* @since 3.10.0
*/
var TreeFormatter = {
	formatIssue: (issue) => map(formatTree(issue), drawTree),
	formatIssueSync: (issue) => {
		const e = TreeFormatter.formatIssue(issue);
		return isEither(e) ? require_Layer.getOrThrow(e) : require_Layer.runSync(e);
	},
	formatError: (error) => TreeFormatter.formatIssue(error.issue),
	formatErrorSync: (error) => TreeFormatter.formatIssueSync(error.issue)
};
var drawTree = (tree) => tree.value + draw("\n", tree.forest);
var draw = (indentation, forest) => {
	let r = "";
	const len = forest.length;
	let tree;
	for (let i = 0; i < len; i++) {
		tree = forest[i];
		const isLast = i === len - 1;
		r += indentation + (isLast ? "└" : "├") + "─ " + tree.value;
		r += draw(indentation + (len > 1 && !isLast ? "│  " : "   "), tree.forest);
	}
	return r;
};
var formatTransformationKind = (kind) => {
	switch (kind) {
		case "Encoded": return "Encoded side transformation failure";
		case "Transformation": return "Transformation process failure";
		case "Type": return "Type side transformation failure";
	}
};
var formatRefinementKind = (kind) => {
	switch (kind) {
		case "From": return "From side refinement failure";
		case "Predicate": return "Predicate refinement failure";
	}
};
var getAnnotated = (issue) => "ast" in issue ? require_Layer.some(issue.ast) : require_Layer.none$1();
var Either_void = /* @__PURE__ */ require_Layer.right(void 0);
var getCurrentMessage = (issue) => getAnnotated(issue).pipe(require_Layer.flatMap$2(getMessageAnnotation), require_Layer.match({
	onNone: () => Either_void,
	onSome: (messageAnnotation) => {
		const union = messageAnnotation(issue);
		if (require_Layer.isString(union)) return require_Layer.right({
			message: union,
			override: false
		});
		if (require_Layer.isEffect(union)) return require_Layer.map(union, (message) => ({
			message,
			override: false
		}));
		if (require_Layer.isString(union.message)) return require_Layer.right({
			message: union.message,
			override: union.override
		});
		return require_Layer.map(union.message, (message) => ({
			message,
			override: union.override
		}));
	}
}));
var createParseIssueGuard = (tag) => (issue) => issue._tag === tag;
/**
* Returns `true` if the value is a `Composite`.
*
* @category guards
* @since 3.10.0
*/
var isComposite = /* @__PURE__ */ createParseIssueGuard("Composite");
var isRefinement = /* @__PURE__ */ createParseIssueGuard("Refinement");
var isTransformation = /* @__PURE__ */ createParseIssueGuard("Transformation");
var getMessage = (issue) => flatMap(getCurrentMessage(issue), (currentMessage) => {
	if (currentMessage !== void 0) return !currentMessage.override && (isComposite(issue) || isRefinement(issue) && issue.kind === "From" || isTransformation(issue) && issue.kind !== "Transformation") ? isTransformation(issue) || isRefinement(issue) ? getMessage(issue.issue) : Either_void : require_Layer.right(currentMessage.message);
	return Either_void;
});
var getParseIssueTitleAnnotation = (issue) => getAnnotated(issue).pipe(require_Layer.flatMap$2(getParseIssueTitleAnnotation$1), require_Layer.flatMapNullable((annotation) => annotation(issue)), require_Layer.getOrUndefined);
/** @internal */
function getRefinementExpected(ast) {
	return getDescriptionAnnotation(ast).pipe(require_Layer.orElse(() => getTitleAnnotation(ast)), require_Layer.orElse(() => getAutoTitleAnnotation(ast)), require_Layer.orElse(() => getIdentifierAnnotation(ast)), require_Layer.getOrElse(() => `{ ${ast.from} | filter }`));
}
function getDefaultTypeMessage(issue) {
	if (issue.message !== void 0) return issue.message;
	return `Expected ${isRefinement$1(issue.ast) ? getRefinementExpected(issue.ast) : String(issue.ast)}, actual ${require_Layer.formatUnknown(issue.actual)}`;
}
var formatTypeMessage = (issue) => map(getMessage(issue), (message) => message ?? getParseIssueTitleAnnotation(issue) ?? getDefaultTypeMessage(issue));
var getParseIssueTitle = (issue) => getParseIssueTitleAnnotation(issue) ?? String(issue.ast);
var formatForbiddenMessage = (issue) => issue.message ?? "is forbidden";
var formatUnexpectedMessage = (issue) => issue.message ?? "is unexpected";
var formatMissingMessage = (issue) => {
	const missingMessageAnnotation = getMissingMessageAnnotation(issue.ast);
	if (require_Layer.isSome(missingMessageAnnotation)) {
		const annotation = missingMessageAnnotation.value();
		return require_Layer.isString(annotation) ? require_Layer.right(annotation) : annotation;
	}
	return require_Layer.right(issue.message ?? "is missing");
};
var formatTree = (issue) => {
	switch (issue._tag) {
		case "Type": return map(formatTypeMessage(issue), makeTree);
		case "Forbidden": return require_Layer.right(makeTree(getParseIssueTitle(issue), [makeTree(formatForbiddenMessage(issue))]));
		case "Unexpected": return require_Layer.right(makeTree(formatUnexpectedMessage(issue)));
		case "Missing": return map(formatMissingMessage(issue), makeTree);
		case "Transformation": return flatMap(getMessage(issue), (message) => {
			if (message !== void 0) return require_Layer.right(makeTree(message));
			return map(formatTree(issue.issue), (tree) => makeTree(getParseIssueTitle(issue), [makeTree(formatTransformationKind(issue.kind), [tree])]));
		});
		case "Refinement": return flatMap(getMessage(issue), (message) => {
			if (message !== void 0) return require_Layer.right(makeTree(message));
			return map(formatTree(issue.issue), (tree) => makeTree(getParseIssueTitle(issue), [makeTree(formatRefinementKind(issue.kind), [tree])]));
		});
		case "Pointer": return map(formatTree(issue.issue), (tree) => makeTree(formatPath(issue.path), [tree]));
		case "Composite": return flatMap(getMessage(issue), (message) => {
			if (message !== void 0) return require_Layer.right(makeTree(message));
			const parseIssueTitle = getParseIssueTitle(issue);
			return isNonEmpty$1(issue.issues) ? map(require_Layer.forEach(issue.issues, formatTree), (forest) => makeTree(parseIssueTitle, forest)) : map(formatTree(issue.issues), (tree) => makeTree(parseIssueTitle, [tree]));
		});
	}
};
//#endregion
//#region node_modules/.pnpm/effect@3.21.2/node_modules/effect/dist/esm/Struct.js
/**
* Create a new object by picking properties of an existing object.
*
* @example
* ```ts
* import * as assert from "node:assert"
* import { pipe, Struct } from "effect"
*
* assert.deepStrictEqual(pipe({ a: "a", b: 1, c: true }, Struct.pick("a", "b")), { a: "a", b: 1 })
* assert.deepStrictEqual(Struct.pick({ a: "a", b: 1, c: true }, "a", "b"), { a: "a", b: 1 })
* ```
*
* @since 2.0.0
*/
var pick = /* @__PURE__ */ require_Layer.dual((args) => require_Layer.isObject(args[0]), (s, ...keys) => {
	const out = {};
	for (const k of keys) if (k in s) out[k] = s[k];
	return out;
});
/**
* Create a new object by omitting properties of an existing object.
*
* @example
* ```ts
* import * as assert from "node:assert"
* import { pipe, Struct } from "effect"
*
* assert.deepStrictEqual(pipe({ a: "a", b: 1, c: true }, Struct.omit("c")), { a: "a", b: 1 })
* assert.deepStrictEqual(Struct.omit({ a: "a", b: 1, c: true }, "c"), { a: "a", b: 1 })
* ```
*
* @since 2.0.0
*/
var omit = /* @__PURE__ */ require_Layer.dual((args) => require_Layer.isObject(args[0]), (s, ...keys) => {
	const out = { ...s };
	for (const k of keys) delete out[k];
	return out;
});
//#endregion
//#region node_modules/.pnpm/effect@3.21.2/node_modules/effect/dist/esm/Schema.js
/**
* @since 3.10.0
*/
/**
* @since 3.10.0
* @category symbol
*/
var TypeId = /* @__PURE__ */ Symbol.for("effect/Schema");
/**
* @category constructors
* @since 3.10.0
*/
function make(ast) {
	return class SchemaClass {
		[TypeId] = variance;
		static ast = ast;
		static annotations(annotations) {
			return make(mergeSchemaAnnotations(this.ast, annotations));
		}
		static pipe() {
			return require_Layer.pipeArguments(this, arguments);
		}
		static toString() {
			return String(ast);
		}
		static Type;
		static Encoded;
		static Context;
		static [TypeId] = variance;
	};
}
var variance = {
	/* c8 ignore next */
	_A: (_) => _,
	/* c8 ignore next */
	_I: (_) => _,
	/* c8 ignore next */
	_R: (_) => _
};
var builtInAnnotations = {
	typeConstructor: TypeConstructorAnnotationId,
	schemaId: SchemaIdAnnotationId,
	message: MessageAnnotationId,
	missingMessage: MissingMessageAnnotationId,
	identifier: IdentifierAnnotationId,
	title: TitleAnnotationId,
	description: DescriptionAnnotationId,
	examples: ExamplesAnnotationId,
	default: DefaultAnnotationId,
	documentation: DocumentationAnnotationId,
	jsonSchema: JSONSchemaAnnotationId,
	arbitrary: ArbitraryAnnotationId,
	pretty: PrettyAnnotationId,
	equivalence: EquivalenceAnnotationId,
	concurrency: ConcurrencyAnnotationId,
	batching: BatchingAnnotationId,
	parseIssueTitle: ParseIssueTitleAnnotationId,
	parseOptions: ParseOptionsAnnotationId,
	decodingFallback: DecodingFallbackAnnotationId
};
var toASTAnnotations = (annotations) => {
	if (!annotations) return {};
	const out = { ...annotations };
	for (const key in builtInAnnotations) if (key in annotations) {
		const id = builtInAnnotations[key];
		out[id] = annotations[key];
		delete out[key];
	}
	return out;
};
var mergeSchemaAnnotations = (ast, annotations$3) => annotations(ast, toASTAnnotations(annotations$3));
/**
* @category formatting
* @since 3.10.0
*/
var format = (schema) => String(schema.ast);
/**
* @category decoding
* @since 3.10.0
*/
var decodeUnknownEither = (schema, options) => {
	const decodeUnknownEither = decodeUnknownEither$1(schema, options);
	return (u, overrideOptions) => require_Layer.mapLeft(decodeUnknownEither(u, overrideOptions), parseError);
};
/**
* Tests if a value is a `Schema`.
*
* @category guards
* @since 3.10.0
*/
var isSchema = (u) => require_Layer.hasProperty(u, TypeId) && require_Layer.isObject(u[TypeId]);
function getDefaultLiteralAST(literals) {
	return isMembers(literals) ? Union$1.make(mapMembers(literals, (literal) => new Literal$1(literal))) : new Literal$1(literals[0]);
}
function makeLiteralClass(literals, ast = getDefaultLiteralAST(literals)) {
	return class LiteralClass extends make(ast) {
		static annotations(annotations) {
			return makeLiteralClass(this.literals, mergeSchemaAnnotations(this.ast, annotations));
		}
		static literals = [...literals];
	};
}
function Literal(...literals) {
	return require_Layer.isNonEmptyReadonlyArray(literals) ? makeLiteralClass(literals) : Never;
}
var declareConstructor = (typeParameters, options, annotations) => makeDeclareClass(typeParameters, new Declaration(typeParameters.map((tp) => tp.ast), (...typeParameters) => options.decode(...typeParameters.map(make)), (...typeParameters) => options.encode(...typeParameters.map(make)), toASTAnnotations(annotations)));
var declarePrimitive = (is, annotations) => {
	const decodeUnknown = () => (input, _, ast) => is(input) ? succeed(input) : fail(new Type(ast, input));
	return makeDeclareClass([], new Declaration([], decodeUnknown, decodeUnknown, toASTAnnotations(annotations)));
};
function makeDeclareClass(typeParameters, ast) {
	return class DeclareClass extends make(ast) {
		static annotations(annotations) {
			return makeDeclareClass(this.typeParameters, mergeSchemaAnnotations(this.ast, annotations));
		}
		static typeParameters = [...typeParameters];
	};
}
/**
* The constraint `R extends Schema.Context<P[number]>` enforces dependencies solely from `typeParameters`.
* This ensures that when you call `Schema.to` or `Schema.from`, you receive a schema with a `never` context.
*
* @category constructors
* @since 3.10.0
*/
var declare = function() {
	if (Array.isArray(arguments[0])) {
		const typeParameters = arguments[0];
		const options = arguments[1];
		const annotations = arguments[2];
		return declareConstructor(typeParameters, options, annotations);
	}
	const is = arguments[0];
	const annotations = arguments[1];
	return declarePrimitive(is, annotations);
};
/**
* @category schema id
* @since 3.10.0
*/
var InstanceOfSchemaId = /* @__PURE__ */ Symbol.for("effect/SchemaId/InstanceOf");
/**
* @category constructors
* @since 3.10.0
*/
var instanceOf = (constructor, annotations) => declare((u) => u instanceof constructor, {
	title: constructor.name,
	description: `an instance of ${constructor.name}`,
	pretty: () => String,
	schemaId: InstanceOfSchemaId,
	[InstanceOfSchemaId]: { constructor },
	...annotations
});
/**
* @category primitives
* @since 3.10.0
*/
var Undefined = class extends make(undefinedKeyword) {};
/**
* @category primitives
* @since 3.10.0
*/
var Null = class extends make($null) {};
/**
* @category primitives
* @since 3.10.0
*/
var Never = class extends make(neverKeyword) {};
/**
* @category primitives
* @since 3.10.0
*/
var Unknown = class extends make(unknownKeyword) {};
/**
* @category primitives
* @since 3.10.0
*/
var BigIntFromSelf = class extends make(bigIntKeyword) {};
/**
* @category primitives
* @since 3.10.0
*/
var SymbolFromSelf = class extends make(symbolKeyword) {};
/** @ignore */
var String$ = class extends make(stringKeyword) {};
/** @ignore */
var Number$ = class extends make(numberKeyword) {};
/** @ignore */
var Boolean$ = class extends make(booleanKeyword) {};
var getDefaultUnionAST = (members) => Union$1.make(members.map((m) => m.ast));
function makeUnionClass(members, ast = getDefaultUnionAST(members)) {
	return class UnionClass extends make(ast) {
		static annotations(annotations) {
			return makeUnionClass(this.members, mergeSchemaAnnotations(this.ast, annotations));
		}
		static members = [...members];
	};
}
function Union(...members) {
	return isMembers(members) ? makeUnionClass(members) : require_Layer.isNonEmptyReadonlyArray(members) ? members[0] : Never;
}
/**
* @category combinators
* @since 3.10.0
*/
var UndefinedOr = (self) => Union(self, Undefined);
/**
* @since 3.10.0
*/
var element = (self) => new ElementImpl(new OptionalType(self.ast, false), self);
var ElementImpl = class ElementImpl {
	ast;
	from;
	[TypeId];
	_Token;
	constructor(ast, from) {
		this.ast = ast;
		this.from = from;
	}
	annotations(annotations) {
		return new ElementImpl(new OptionalType(this.ast.type, this.ast.isOptional, {
			...this.ast.annotations,
			...toASTAnnotations(annotations)
		}), this.from);
	}
	toString() {
		return `${this.ast.type}${this.ast.isOptional ? "?" : ""}`;
	}
};
var getDefaultTupleTypeAST = (elements, rest) => new TupleType(elements.map((el) => isSchema(el) ? new OptionalType(el.ast, false) : el.ast), rest.map((el) => isSchema(el) ? new Type$1(el.ast) : el.ast), true);
function makeTupleTypeClass(elements, rest, ast = getDefaultTupleTypeAST(elements, rest)) {
	return class TupleTypeClass extends make(ast) {
		static annotations(annotations) {
			return makeTupleTypeClass(this.elements, this.rest, mergeSchemaAnnotations(this.ast, annotations));
		}
		static elements = [...elements];
		static rest = [...rest];
	};
}
function Tuple(...args) {
	return Array.isArray(args[0]) ? makeTupleTypeClass(args[0], args.slice(1)) : makeTupleTypeClass(args, []);
}
function makeArrayClass(value, ast) {
	return class ArrayClass extends makeTupleTypeClass([], [value], ast) {
		static annotations(annotations) {
			return makeArrayClass(this.value, mergeSchemaAnnotations(this.ast, annotations));
		}
		static value = value;
	};
}
var Array$ = (value) => makeArrayClass(value);
var formatPropertySignatureToken = (isOptional) => isOptional ? "\"?:\"" : "\":\"";
/**
* @category PropertySignature
* @since 3.10.0
*/
var PropertySignatureDeclaration = class extends OptionalType {
	isReadonly;
	defaultValue;
	/**
	* @since 3.10.0
	*/
	_tag = "PropertySignatureDeclaration";
	constructor(type, isOptional, isReadonly, annotations, defaultValue) {
		super(type, isOptional, annotations);
		this.isReadonly = isReadonly;
		this.defaultValue = defaultValue;
	}
	/**
	* @since 3.10.0
	*/
	toString() {
		const token = formatPropertySignatureToken(this.isOptional);
		const type = String(this.type);
		return `PropertySignature<${token}, ${type}, never, ${token}, ${type}>`;
	}
};
/**
* @category PropertySignature
* @since 3.10.0
*/
var ToPropertySignature = class extends OptionalType {
	isReadonly;
	defaultValue;
	constructor(type, isOptional, isReadonly, annotations, defaultValue) {
		super(type, isOptional, annotations);
		this.isReadonly = isReadonly;
		this.defaultValue = defaultValue;
	}
};
var formatPropertyKey = (p) => {
	if (p === void 0) return "never";
	if (require_Layer.isString(p)) return JSON.stringify(p);
	return String(p);
};
/**
* @category PropertySignature
* @since 3.10.0
*/
var PropertySignatureTransformation = class {
	from;
	to;
	decode;
	encode;
	/**
	* @since 3.10.0
	*/
	_tag = "PropertySignatureTransformation";
	constructor(from, to, decode, encode) {
		this.from = from;
		this.to = to;
		this.decode = decode;
		this.encode = encode;
	}
	/**
	* @since 3.10.0
	*/
	toString() {
		return `PropertySignature<${formatPropertySignatureToken(this.to.isOptional)}, ${this.to.type}, ${formatPropertyKey(this.from.fromKey)}, ${formatPropertySignatureToken(this.from.isOptional)}, ${this.from.type}>`;
	}
};
var mergeSignatureAnnotations = (ast, annotations) => {
	switch (ast._tag) {
		case "PropertySignatureDeclaration": return new PropertySignatureDeclaration(ast.type, ast.isOptional, ast.isReadonly, {
			...ast.annotations,
			...annotations
		}, ast.defaultValue);
		case "PropertySignatureTransformation": return new PropertySignatureTransformation(ast.from, new ToPropertySignature(ast.to.type, ast.to.isOptional, ast.to.isReadonly, {
			...ast.to.annotations,
			...annotations
		}, ast.to.defaultValue), ast.decode, ast.encode);
	}
};
/**
* @since 3.10.0
* @category symbol
*/
var PropertySignatureTypeId = /* @__PURE__ */ Symbol.for("effect/PropertySignature");
/**
* @since 3.10.0
* @category guards
*/
var isPropertySignature = (u) => require_Layer.hasProperty(u, PropertySignatureTypeId);
var PropertySignatureImpl = class PropertySignatureImpl {
	ast;
	[TypeId];
	[PropertySignatureTypeId] = null;
	_TypeToken;
	_Key;
	_EncodedToken;
	_HasDefault;
	constructor(ast) {
		this.ast = ast;
	}
	pipe() {
		return require_Layer.pipeArguments(this, arguments);
	}
	annotations(annotations) {
		return new PropertySignatureImpl(mergeSignatureAnnotations(this.ast, toASTAnnotations(annotations)));
	}
	toString() {
		return String(this.ast);
	}
};
/**
* @category PropertySignature
* @since 3.10.0
*/
var makePropertySignature = (ast) => new PropertySignatureImpl(ast);
var PropertySignatureWithFromImpl = class PropertySignatureWithFromImpl extends PropertySignatureImpl {
	from;
	constructor(ast, from) {
		super(ast);
		this.from = from;
	}
	annotations(annotations) {
		return new PropertySignatureWithFromImpl(mergeSignatureAnnotations(this.ast, toASTAnnotations(annotations)), this.from);
	}
};
/**
* Lifts a `Schema` into a `PropertySignature`.
*
* @category PropertySignature
* @since 3.10.0
*/
var propertySignature = (self) => new PropertySignatureWithFromImpl(new PropertySignatureDeclaration(self.ast, false, true, {}, void 0), self);
/**
* Enhances a property signature with a default constructor value.
*
* @category PropertySignature
* @since 3.10.0
*/
var withConstructorDefault = /* @__PURE__ */ require_Layer.dual(2, (self, defaultValue) => {
	const ast = self.ast;
	switch (ast._tag) {
		case "PropertySignatureDeclaration": return makePropertySignature(new PropertySignatureDeclaration(ast.type, ast.isOptional, ast.isReadonly, ast.annotations, defaultValue));
		case "PropertySignatureTransformation": return makePropertySignature(new PropertySignatureTransformation(ast.from, new ToPropertySignature(ast.to.type, ast.to.isOptional, ast.to.isReadonly, ast.to.annotations, defaultValue), ast.decode, ast.encode));
	}
});
/**
* @category PropertySignature
* @since 3.10.0
*/
var optional = (self) => {
	return new PropertySignatureWithFromImpl(new PropertySignatureDeclaration(self.ast === undefinedKeyword || self.ast === neverKeyword ? undefinedKeyword : UndefinedOr(self).ast, true, true, {}, void 0), self);
};
var preserveMissingMessageAnnotation = /* @__PURE__ */ pickAnnotations([MissingMessageAnnotationId]);
var getDefaultTypeLiteralAST = (fields, records) => {
	const ownKeys = Reflect.ownKeys(fields);
	const pss = [];
	if (ownKeys.length > 0) {
		const from = [];
		const to = [];
		const transformations = [];
		for (let i = 0; i < ownKeys.length; i++) {
			const key = ownKeys[i];
			const field = fields[key];
			if (isPropertySignature(field)) {
				const ast = field.ast;
				switch (ast._tag) {
					case "PropertySignatureDeclaration": {
						const type = ast.type;
						const isOptional = ast.isOptional;
						const toAnnotations = ast.annotations;
						from.push(new PropertySignature(key, type, isOptional, true, preserveMissingMessageAnnotation(ast)));
						to.push(new PropertySignature(key, typeAST(type), isOptional, true, toAnnotations));
						pss.push(new PropertySignature(key, type, isOptional, true, toAnnotations));
						break;
					}
					case "PropertySignatureTransformation": {
						const fromKey = ast.from.fromKey ?? key;
						from.push(new PropertySignature(fromKey, ast.from.type, ast.from.isOptional, true, ast.from.annotations));
						to.push(new PropertySignature(key, ast.to.type, ast.to.isOptional, true, ast.to.annotations));
						transformations.push(new PropertySignatureTransformation$1(fromKey, key, ast.decode, ast.encode));
						break;
					}
				}
			} else {
				from.push(new PropertySignature(key, field.ast, false, true));
				to.push(new PropertySignature(key, typeAST(field.ast), false, true));
				pss.push(new PropertySignature(key, field.ast, false, true));
			}
		}
		if (require_Layer.isNonEmptyReadonlyArray(transformations)) {
			const issFrom = [];
			const issTo = [];
			for (const r of records) {
				const { indexSignatures, propertySignatures } = record(r.key.ast, r.value.ast);
				propertySignatures.forEach((ps) => {
					from.push(ps);
					to.push(new PropertySignature(ps.name, typeAST(ps.type), ps.isOptional, ps.isReadonly, ps.annotations));
				});
				indexSignatures.forEach((is) => {
					issFrom.push(is);
					issTo.push(new IndexSignature(is.parameter, typeAST(is.type), is.isReadonly));
				});
			}
			return new Transformation$1(new TypeLiteral(from, issFrom, { [AutoTitleAnnotationId]: "Struct (Encoded side)" }), new TypeLiteral(to, issTo, { [AutoTitleAnnotationId]: "Struct (Type side)" }), new TypeLiteralTransformation(transformations));
		}
	}
	const iss = [];
	for (const r of records) {
		const { indexSignatures, propertySignatures } = record(r.key.ast, r.value.ast);
		propertySignatures.forEach((ps) => pss.push(ps));
		indexSignatures.forEach((is) => iss.push(is));
	}
	return new TypeLiteral(pss, iss);
};
var lazilyMergeDefaults = (fields, out) => {
	const ownKeys = Reflect.ownKeys(fields);
	for (const key of ownKeys) {
		const field = fields[key];
		if (out[key] === void 0 && isPropertySignature(field)) {
			const ast = field.ast;
			const defaultValue = ast._tag === "PropertySignatureDeclaration" ? ast.defaultValue : ast.to.defaultValue;
			if (defaultValue !== void 0) out[key] = defaultValue();
		}
	}
	return out;
};
function makeTypeLiteralClass(fields, records, ast = getDefaultTypeLiteralAST(fields, records)) {
	return class TypeLiteralClass extends make(ast) {
		static annotations(annotations) {
			return makeTypeLiteralClass(this.fields, this.records, mergeSchemaAnnotations(this.ast, annotations));
		}
		static fields = { ...fields };
		static records = [...records];
		static make = (props, options) => {
			const propsWithDefaults = lazilyMergeDefaults(fields, { ...props });
			return getDisableValidationMakeOption(options) ? propsWithDefaults : validateSync(this)(propsWithDefaults);
		};
		static pick(...keys) {
			return Struct(pick(fields, ...keys));
		}
		static omit(...keys) {
			return Struct(omit(fields, ...keys));
		}
	};
}
function Struct(fields, ...records) {
	return makeTypeLiteralClass(fields, records);
}
/**
* Returns a property signature that represents a tag.
* A tag is a literal value that is used to distinguish between different types of objects.
* The tag is optional when using the `make` method.
*
* @example
* ```ts
* import * as assert from "node:assert"
* import { Schema } from "effect"
*
* const User = Schema.Struct({
*   _tag: Schema.tag("User"),
*   name: Schema.String,
*   age: Schema.Number
* })
*
* assert.deepStrictEqual(User.make({ name: "John", age: 44 }), { _tag: "User", name: "John", age: 44 })
* ```
*
* @see {@link TaggedStruct}
*
* @since 3.10.0
*/
var tag = (tag) => Literal(tag).pipe(propertySignature, withConstructorDefault(() => tag));
/**
* A tagged struct is a struct that has a tag property that is used to distinguish between different types of objects.
*
* The tag is optional when using the `make` method.
*
* @example
* ```ts
* import * as assert from "node:assert"
* import { Schema } from "effect"
*
* const User = Schema.TaggedStruct("User", {
*   name: Schema.String,
*   age: Schema.Number
* })
*
* assert.deepStrictEqual(User.make({ name: "John", age: 44 }), { _tag: "User", name: "John", age: 44 })
* ```
*
* @category constructors
* @since 3.10.0
*/
var TaggedStruct = (value, fields) => Struct({
	_tag: tag(value),
	...fields
});
/**
* @category constructors
* @since 3.10.0
*/
var suspend = (f) => make(new Suspend(() => f().ast));
/**
* @since 3.10.0
* @category symbol
*/
var RefineSchemaId = /* @__PURE__ */ Symbol.for("effect/SchemaId/Refine");
function makeRefineClass(from, filter, ast) {
	return class RefineClass extends make(ast) {
		static annotations(annotations) {
			return makeRefineClass(this.from, this.filter, mergeSchemaAnnotations(this.ast, annotations));
		}
		static [RefineSchemaId] = from;
		static from = from;
		static filter = filter;
		static make = (a, options) => {
			return getDisableValidationMakeOption(options) ? a : validateSync(this)(a);
		};
	};
}
var fromFilterPredicateReturnTypeItem = (item, ast, input) => {
	if (require_Layer.isBoolean(item)) return item ? require_Layer.none$1() : require_Layer.some(new Type(ast, input));
	if (require_Layer.isString(item)) return require_Layer.some(new Type(ast, input, item));
	if (item !== void 0) {
		if ("_tag" in item) return require_Layer.some(item);
		const issue = new Type(ast, input, item.message);
		return require_Layer.some(require_Layer.isNonEmptyReadonlyArray(item.path) ? new Pointer(item.path, input, issue) : issue);
	}
	return require_Layer.none$1();
};
var toFilterParseIssue = (out, ast, input) => {
	if (isSingle(out)) return fromFilterPredicateReturnTypeItem(out, ast, input);
	if (require_Layer.isNonEmptyReadonlyArray(out)) {
		const issues = require_Layer.filterMap(out, (issue) => fromFilterPredicateReturnTypeItem(issue, ast, input));
		if (require_Layer.isNonEmptyReadonlyArray(issues)) return require_Layer.some(issues.length === 1 ? issues[0] : new Composite(ast, input, issues));
	}
	return require_Layer.none$1();
};
function filter(predicate, annotations) {
	return (self) => {
		function filter(input, options, ast) {
			return toFilterParseIssue(predicate(input, options, ast), ast, input);
		}
		return makeRefineClass(self, filter, new Refinement$1(self.ast, filter, toASTAnnotations(annotations)));
	};
}
function makeTransformationClass(from, to, ast) {
	return class TransformationClass extends make(ast) {
		static annotations(annotations) {
			return makeTransformationClass(this.from, this.to, mergeSchemaAnnotations(this.ast, annotations));
		}
		static from = from;
		static to = to;
	};
}
/**
* Create a new `Schema` by transforming the input and output of an existing `Schema`
* using the provided decoding functions.
*
* @category transformations
* @since 3.10.0
*/
var transformOrFail = /* @__PURE__ */ require_Layer.dual((args) => isSchema(args[0]) && isSchema(args[1]), (from, to, options) => makeTransformationClass(from, to, new Transformation$1(from.ast, to.ast, new FinalTransformation(options.decode, options.encode))));
/**
* Create a new `Schema` by transforming the input and output of an existing `Schema`
* using the provided mapping functions.
*
* @category transformations
* @since 3.10.0
*/
var transform = /* @__PURE__ */ require_Layer.dual((args) => isSchema(args[0]) && isSchema(args[1]), (from, to, options) => transformOrFail(from, to, {
	strict: true,
	decode: (fromA, _options, _ast, toA) => succeed(options.decode(fromA, toA)),
	encode: (toI, _options, _ast, toA) => succeed(options.encode(toI, toA))
}));
/**
* @category schema id
* @since 3.10.0
*/
var TrimmedSchemaId = /* @__PURE__ */ Symbol.for("effect/SchemaId/Trimmed");
/**
* Verifies that a string contains no leading or trailing whitespaces.
*
* Note. This combinator does not make any transformations, it only validates.
* If what you were looking for was a combinator to trim strings, then check out the `trim` combinator.
*
* @category string filters
* @since 3.10.0
*/
var trimmed = (annotations) => (self) => self.pipe(filter((a) => a === a.trim(), {
	schemaId: TrimmedSchemaId,
	title: "trimmed",
	description: "a string with no leading or trailing whitespace",
	jsonSchema: { pattern: "^\\S[\\s\\S]*\\S$|^\\S$|^$" },
	...annotations
}));
/**
* @category schema id
* @since 3.10.0
*/
var MinLengthSchemaId = MinLengthSchemaId$1;
/**
* @category string filters
* @since 3.10.0
*/
var minLength = (minLength, annotations) => (self) => self.pipe(filter((a) => a.length >= minLength, {
	schemaId: MinLengthSchemaId,
	title: `minLength(${minLength})`,
	description: `a string at least ${minLength} character(s) long`,
	jsonSchema: { minLength },
	...annotations
}));
/**
* @category schema id
* @since 3.10.0
*/
var LengthSchemaId = LengthSchemaId$1;
/**
* @category string filters
* @since 3.10.0
*/
var length = (length, annotations) => (self) => {
	const minLength = require_Layer.isObject(length) ? Math.max(0, Math.floor(length.min)) : Math.max(0, Math.floor(length));
	const maxLength = require_Layer.isObject(length) ? Math.max(minLength, Math.floor(length.max)) : minLength;
	if (minLength !== maxLength) return self.pipe(filter((a) => a.length >= minLength && a.length <= maxLength, {
		schemaId: LengthSchemaId,
		title: `length({ min: ${minLength}, max: ${maxLength})`,
		description: `a string at least ${minLength} character(s) and at most ${maxLength} character(s) long`,
		jsonSchema: {
			minLength,
			maxLength
		},
		...annotations
	}));
	return self.pipe(filter((a) => a.length === minLength, {
		schemaId: LengthSchemaId,
		title: `length(${minLength})`,
		description: minLength === 1 ? `a single character` : `a string ${minLength} character(s) long`,
		jsonSchema: {
			minLength,
			maxLength: minLength
		},
		...annotations
	}));
};
/**
* @category schema id
* @since 3.10.0
*/
var PatternSchemaId = /* @__PURE__ */ Symbol.for("effect/SchemaId/Pattern");
/**
* @category string filters
* @since 3.10.0
*/
var pattern = (regex, annotations) => (self) => {
	const source = regex.source;
	return self.pipe(filter((a) => {
		regex.lastIndex = 0;
		return regex.test(a);
	}, {
		schemaId: PatternSchemaId,
		[PatternSchemaId]: { regex },
		description: `a string matching the pattern ${source}`,
		jsonSchema: { pattern: source },
		...annotations
	}));
};
/**
* @category schema id
* @since 3.10.0
*/
var LowercasedSchemaId = /* @__PURE__ */ Symbol.for("effect/SchemaId/Lowercased");
/**
* Verifies that a string is lowercased.
*
* @category string filters
* @since 3.10.0
*/
var lowercased = (annotations) => (self) => self.pipe(filter((a) => a === a.toLowerCase(), {
	schemaId: LowercasedSchemaId,
	title: "lowercased",
	description: "a lowercase string",
	jsonSchema: { pattern: "^[^A-Z]*$" },
	...annotations
}));
/**
* @category string constructors
* @since 3.10.0
*/
var Lowercased = class extends String$.pipe(/* @__PURE__ */ lowercased({ identifier: "Lowercased" })) {};
/**
* @category schema id
* @since 3.10.0
*/
var UppercasedSchemaId = /* @__PURE__ */ Symbol.for("effect/SchemaId/Uppercased");
/**
* Verifies that a string is uppercased.
*
* @category string filters
* @since 3.10.0
*/
var uppercased = (annotations) => (self) => self.pipe(filter((a) => a === a.toUpperCase(), {
	schemaId: UppercasedSchemaId,
	title: "uppercased",
	description: "an uppercase string",
	jsonSchema: { pattern: "^[^a-z]*$" },
	...annotations
}));
/**
* @category string constructors
* @since 3.10.0
*/
var Uppercased = class extends String$.pipe(/* @__PURE__ */ uppercased({ identifier: "Uppercased" })) {};
/**
* @category schema id
* @since 3.10.0
*/
var CapitalizedSchemaId = /* @__PURE__ */ Symbol.for("effect/SchemaId/Capitalized");
/**
* Verifies that a string is capitalized.
*
* @category string filters
* @since 3.10.0
*/
var capitalized = (annotations) => (self) => self.pipe(filter((a) => a[0]?.toUpperCase() === a[0], {
	schemaId: CapitalizedSchemaId,
	title: "capitalized",
	description: "a capitalized string",
	jsonSchema: { pattern: "^[^a-z]?.*$" },
	...annotations
}));
/**
* @category string constructors
* @since 3.10.0
*/
var Capitalized = class extends String$.pipe(/* @__PURE__ */ capitalized({ identifier: "Capitalized" })) {};
/**
* @category schema id
* @since 3.10.0
*/
var UncapitalizedSchemaId = /* @__PURE__ */ Symbol.for("effect/SchemaId/Uncapitalized");
/**
* Verifies that a string is uncapitalized.
*
* @category string filters
* @since 3.10.0
*/
var uncapitalized = (annotations) => (self) => self.pipe(filter((a) => a[0]?.toLowerCase() === a[0], {
	schemaId: UncapitalizedSchemaId,
	title: "uncapitalized",
	description: "a uncapitalized string",
	jsonSchema: { pattern: "^[^A-Z]?.*$" },
	...annotations
}));
/**
* @category string constructors
* @since 3.10.0
*/
var Uncapitalized = class extends String$.pipe(/* @__PURE__ */ uncapitalized({ identifier: "Uncapitalized" })) {};
String$.pipe(/* @__PURE__ */ length(1, { identifier: "Char" }));
/**
* @category string filters
* @since 3.10.0
*/
var nonEmptyString = (annotations) => minLength(1, {
	title: "nonEmptyString",
	description: "a non empty string",
	...annotations
});
transform(String$.annotations({ description: "a string that will be converted to lowercase" }), Lowercased, {
	strict: true,
	decode: (i) => i.toLowerCase(),
	encode: require_Layer.identity
}).annotations({ identifier: "Lowercase" });
transform(String$.annotations({ description: "a string that will be converted to uppercase" }), Uppercased, {
	strict: true,
	decode: (i) => i.toUpperCase(),
	encode: require_Layer.identity
}).annotations({ identifier: "Uppercase" });
transform(String$.annotations({ description: "a string that will be converted to a capitalized format" }), Capitalized, {
	strict: true,
	decode: (i) => capitalize(i),
	encode: require_Layer.identity
}).annotations({ identifier: "Capitalize" });
transform(String$.annotations({ description: "a string that will be converted to an uncapitalized format" }), Uncapitalized, {
	strict: true,
	decode: (i) => uncapitalize(i),
	encode: require_Layer.identity
}).annotations({ identifier: "Uncapitalize" });
/**
* @category string constructors
* @since 3.10.0
*/
var Trimmed = class extends String$.pipe(/* @__PURE__ */ trimmed({ identifier: "Trimmed" })) {};
/**
* Useful for validating strings that must contain meaningful characters without
* leading or trailing whitespace.
*
* @example
* ```ts
* import { Schema } from "effect"
*
* console.log(Schema.decodeOption(Schema.NonEmptyTrimmedString)("")) // Option.none()
* console.log(Schema.decodeOption(Schema.NonEmptyTrimmedString)(" a ")) // Option.none()
* console.log(Schema.decodeOption(Schema.NonEmptyTrimmedString)("a")) // Option.some("a")
* ```
*
* @category string constructors
* @since 3.10.0
*/
var NonEmptyTrimmedString = class extends Trimmed.pipe(/* @__PURE__ */ nonEmptyString({ identifier: "NonEmptyTrimmedString" })) {};
transform(String$.annotations({ description: "a string that will be trimmed" }), Trimmed, {
	strict: true,
	decode: (i) => i.trim(),
	encode: require_Layer.identity
}).annotations({ identifier: "Trim" });
var getErrorMessage = (e) => e instanceof Error ? e.message : String(e);
String$.pipe(/* @__PURE__ */ nonEmptyString({ identifier: "NonEmptyString" }));
/**
* @category schema id
* @since 3.10.0
*/
var UUIDSchemaId = /* @__PURE__ */ Symbol.for("effect/SchemaId/UUID");
var uuidRegexp = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/i;
String$.pipe(/* @__PURE__ */ pattern(uuidRegexp, {
	schemaId: UUIDSchemaId,
	identifier: "UUID",
	jsonSchema: {
		format: "uuid",
		pattern: uuidRegexp.source
	},
	description: "a Universally Unique Identifier",
	arbitrary: () => (fc) => fc.uuid()
}));
/**
* @category schema id
* @since 3.10.0
*/
var ULIDSchemaId = /* @__PURE__ */ Symbol.for("effect/SchemaId/ULID");
String$.pipe(/* @__PURE__ */ pattern(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i, {
	schemaId: ULIDSchemaId,
	identifier: "ULID",
	description: "a Universally Unique Lexicographically Sortable Identifier",
	arbitrary: () => (fc) => fc.ulid()
}));
/**
* Defines a schema that represents a `URL` object.
*
* @category URL constructors
* @since 3.11.0
*/
var URLFromSelf = class extends instanceOf(URL, {
	typeConstructor: { _tag: "URL" },
	identifier: "URLFromSelf",
	arbitrary: () => (fc) => fc.webUrl().map((s) => new URL(s)),
	pretty: () => (url) => url.toString()
}) {};
transformOrFail(String$.annotations({ description: "a string to be decoded into a URL" }), URLFromSelf, {
	strict: true,
	decode: (i, _, ast) => _try({
		try: () => new URL(i),
		catch: (e) => new Type(ast, i, `Unable to decode ${JSON.stringify(i)} into a URL. ${getErrorMessage(e)}`)
	}),
	encode: (a) => succeed(a.toString())
}).annotations({
	identifier: "URL",
	pretty: () => (url) => url.toString()
});
/**
* @category schema id
* @since 3.10.0
*/
var FiniteSchemaId = FiniteSchemaId$1;
/**
* Ensures that the provided value is a finite number (excluding NaN, +Infinity, and -Infinity).
*
* @category number filters
* @since 3.10.0
*/
var finite = (annotations) => (self) => self.pipe(filter(Number.isFinite, {
	schemaId: FiniteSchemaId,
	title: "finite",
	description: "a finite number",
	jsonSchema: {},
	...annotations
}));
/**
* @category schema id
* @since 3.10.0
*/
var GreaterThanSchemaId = GreaterThanSchemaId$1;
/**
* This filter checks whether the provided number is greater than the specified minimum.
*
* @category number filters
* @since 3.10.0
*/
var greaterThan = (exclusiveMinimum, annotations) => (self) => self.pipe(filter((a) => a > exclusiveMinimum, {
	schemaId: GreaterThanSchemaId,
	title: `greaterThan(${exclusiveMinimum})`,
	description: exclusiveMinimum === 0 ? "a positive number" : `a number greater than ${exclusiveMinimum}`,
	jsonSchema: { exclusiveMinimum },
	...annotations
}));
/**
* @category schema id
* @since 3.10.0
*/
var GreaterThanOrEqualToSchemaId = GreaterThanOrEqualToSchemaId$1;
/**
* This filter checks whether the provided number is greater than or equal to the specified minimum.
*
* @category number filters
* @since 3.10.0
*/
var greaterThanOrEqualTo = (minimum, annotations) => (self) => self.pipe(filter((a) => a >= minimum, {
	schemaId: GreaterThanOrEqualToSchemaId,
	title: `greaterThanOrEqualTo(${minimum})`,
	description: minimum === 0 ? "a non-negative number" : `a number greater than or equal to ${minimum}`,
	jsonSchema: { minimum },
	...annotations
}));
/**
* @category schema id
* @since 3.10.0
*/
var IntSchemaId = IntSchemaId$1;
/**
* Ensures that the provided value is an integer number (excluding NaN, +Infinity, and -Infinity).
*
* @category number filters
* @since 3.10.0
*/
var int = (annotations) => (self) => self.pipe(filter((a) => Number.isSafeInteger(a), {
	schemaId: IntSchemaId,
	title: "int",
	description: "an integer",
	jsonSchema: { type: "integer" },
	...annotations
}));
/**
* @category schema id
* @since 3.10.0
*/
var LessThanSchemaId = LessThanSchemaId$1;
/**
* This filter checks whether the provided number is less than the specified maximum.
*
* @category number filters
* @since 3.10.0
*/
var lessThan = (exclusiveMaximum, annotations) => (self) => self.pipe(filter((a) => a < exclusiveMaximum, {
	schemaId: LessThanSchemaId,
	title: `lessThan(${exclusiveMaximum})`,
	description: exclusiveMaximum === 0 ? "a negative number" : `a number less than ${exclusiveMaximum}`,
	jsonSchema: { exclusiveMaximum },
	...annotations
}));
/**
* @category schema id
* @since 3.10.0
*/
var LessThanOrEqualToSchemaId = LessThanOrEqualToSchemaId$1;
/**
* This schema checks whether the provided number is less than or equal to the specified maximum.
*
* @category number filters
* @since 3.10.0
*/
var lessThanOrEqualTo = (maximum, annotations) => (self) => self.pipe(filter((a) => a <= maximum, {
	schemaId: LessThanOrEqualToSchemaId,
	title: `lessThanOrEqualTo(${maximum})`,
	description: maximum === 0 ? "a non-positive number" : `a number less than or equal to ${maximum}`,
	jsonSchema: { maximum },
	...annotations
}));
/**
* @category schema id
* @since 3.10.0
*/
var BetweenSchemaId = BetweenSchemaId$1;
/**
* This filter checks whether the provided number falls within the specified minimum and maximum values.
*
* @category number filters
* @since 3.10.0
*/
var between = (minimum, maximum, annotations) => (self) => self.pipe(filter((a) => a >= minimum && a <= maximum, {
	schemaId: BetweenSchemaId,
	title: `between(${minimum}, ${maximum})`,
	description: `a number between ${minimum} and ${maximum}`,
	jsonSchema: {
		minimum,
		maximum
	},
	...annotations
}));
/**
* @category schema id
* @since 3.10.0
*/
var NonNaNSchemaId = NonNaNSchemaId$1;
/**
* @category number filters
* @since 3.10.0
*/
var nonNaN = (annotations) => (self) => self.pipe(filter((a) => !Number.isNaN(a), {
	schemaId: NonNaNSchemaId,
	title: "nonNaN",
	description: "a number excluding NaN",
	...annotations
}));
/**
* @category number filters
* @since 3.10.0
*/
var positive = (annotations) => greaterThan(0, {
	title: "positive",
	...annotations
});
/**
* @category number filters
* @since 3.10.0
*/
var negative = (annotations) => lessThan(0, {
	title: "negative",
	...annotations
});
/**
* @category number filters
* @since 3.10.0
*/
var nonPositive = (annotations) => lessThanOrEqualTo(0, {
	title: "nonPositive",
	...annotations
});
/**
* @category number filters
* @since 3.10.0
*/
var nonNegative = (annotations) => greaterThanOrEqualTo(0, {
	title: "nonNegative",
	...annotations
});
/**
* Transforms a `string` into a `number` by parsing the string using the `parse`
* function of the `effect/Number` module.
*
* It returns an error if the value can't be converted (for example when
* non-numeric characters are provided).
*
* The following special string values are supported: "NaN", "Infinity",
* "-Infinity".
*
* @category number transformations
* @since 3.10.0
*/
function parseNumber(self) {
	return transformOrFail(self, Number$, {
		strict: false,
		decode: (i, _, ast) => fromOption(require_Layer.parse(i), () => new Type(ast, i, `Unable to decode ${JSON.stringify(i)} into a number`)),
		encode: (a) => succeed(String(a))
	});
}
parseNumber(String$.annotations({ description: "a string to be decoded into a number" })).annotations({ identifier: "NumberFromString" });
Number$.pipe(/* @__PURE__ */ finite({ identifier: "Finite" }));
/**
* @category number constructors
* @since 3.10.0
*/
var Int = class extends Number$.pipe(/* @__PURE__ */ int({ identifier: "Int" })) {};
Number$.pipe(/* @__PURE__ */ nonNaN({ identifier: "NonNaN" }));
Number$.pipe(/* @__PURE__ */ positive({ identifier: "Positive" }));
Number$.pipe(/* @__PURE__ */ negative({ identifier: "Negative" }));
Number$.pipe(/* @__PURE__ */ nonPositive({ identifier: "NonPositive" }));
/**
* @category number constructors
* @since 3.10.0
*/
var NonNegative = class extends Number$.pipe(/* @__PURE__ */ nonNegative({ identifier: "NonNegative" })) {};
/**
* @category schema id
* @since 3.10.0
*/
var JsonNumberSchemaId = JsonNumberSchemaId$1;
Number$.pipe(/* @__PURE__ */ finite({
	schemaId: JsonNumberSchemaId,
	identifier: "JsonNumber"
}));
transform(/* @__PURE__ */ Boolean$.annotations({ description: "a boolean that will be negated" }), Boolean$, {
	strict: true,
	decode: (i) => require_Layer.not(i),
	encode: (a) => require_Layer.not(a)
});
var encodeSymbol = (sym, ast) => {
	const key = Symbol.keyFor(sym);
	return key === void 0 ? fail(new Type(ast, sym, `Unable to encode a unique symbol ${String(sym)} into a string`)) : succeed(key);
};
var decodeSymbol = (s) => succeed(Symbol.for(s));
transformOrFail(String$.annotations({ description: "a string to be decoded into a globally shared symbol" }), SymbolFromSelf, {
	strict: false,
	decode: (i) => decodeSymbol(i),
	encode: (a, _, ast) => encodeSymbol(a, ast)
}).annotations({ identifier: "Symbol" });
/**
* @category schema id
* @since 3.10.0
*/
var GreaterThanOrEqualToBigIntSchemaId = GreaterThanOrEqualToBigIntSchemaId$1;
/**
* @category bigint filters
* @since 3.10.0
*/
var greaterThanOrEqualToBigInt = (min, annotations) => (self) => self.pipe(filter((a) => a >= min, {
	schemaId: GreaterThanOrEqualToBigIntSchemaId,
	[GreaterThanOrEqualToBigIntSchemaId]: { min },
	title: `greaterThanOrEqualToBigInt(${min})`,
	description: min === 0n ? "a non-negative bigint" : `a bigint greater than or equal to ${min}n`,
	...annotations
}));
/**
* @category schema id
* @since 3.10.0
*/
var BetweenBigIntSchemaId = BetweenBigintSchemaId;
/**
* @category bigint filters
* @since 3.10.0
*/
var betweenBigInt = (min, max, annotations) => (self) => self.pipe(filter((a) => a >= min && a <= max, {
	schemaId: BetweenBigIntSchemaId,
	[BetweenBigIntSchemaId]: {
		min,
		max
	},
	title: `betweenBigInt(${min}, ${max})`,
	description: `a bigint between ${min}n and ${max}n`,
	...annotations
}));
/**
* @category bigint filters
* @since 3.10.0
*/
var nonNegativeBigInt = (annotations) => greaterThanOrEqualToBigInt(0n, {
	title: "nonNegativeBigInt",
	...annotations
});
/** @ignore */
var BigInt$ = class extends transformOrFail(String$.annotations({ description: "a string to be decoded into a bigint" }), BigIntFromSelf, {
	strict: true,
	decode: (i, _, ast) => fromOption(fromString(i), () => new Type(ast, i, `Unable to decode ${JSON.stringify(i)} into a bigint`)),
	encode: (a) => succeed(String(a))
}).annotations({ identifier: "BigInt" }) {};
/**
* @category bigint constructors
* @since 3.10.0
*/
var NonNegativeBigIntFromSelf = /* @__PURE__ */ BigIntFromSelf.pipe(/* @__PURE__ */ nonNegativeBigInt({ identifier: "NonNegativeBigintFromSelf" }));
transformOrFail(Number$.annotations({ description: "a number to be decoded into a bigint" }), BigIntFromSelf.pipe(betweenBigInt(BigInt(Number.MIN_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER))), {
	strict: true,
	decode: (i, _, ast) => fromOption(fromNumber(i), () => new Type(ast, i, `Unable to decode ${i} into a bigint`)),
	encode: (a, _, ast) => fromOption(toNumber(a), () => new Type(ast, a, `Unable to encode ${a}n into a number`))
}).annotations({ identifier: "BigIntFromNumber" });
var toComposite = (eff, onSuccess, ast, actual) => mapBoth(eff, {
	onFailure: (e) => new Composite(ast, actual, e),
	onSuccess
});
/**
* @category Duration constructors
* @since 3.10.0
*/
var DurationFromSelf = class extends declare(require_Layer.isDuration, {
	typeConstructor: { _tag: "effect/Duration" },
	identifier: "DurationFromSelf",
	pretty: () => String,
	arbitrary: () => (fc) => fc.oneof(fc.constant(require_Layer.infinity), fc.bigInt({ min: 0n }).map((_) => require_Layer.nanos(_)), fc.maxSafeNat().map((_) => require_Layer.millis(_))),
	equivalence: () => require_Layer.Equivalence
}) {};
transformOrFail(NonNegativeBigIntFromSelf.annotations({ description: "a bigint to be decoded into a Duration" }), DurationFromSelf.pipe(filter((duration) => require_Layer.isFinite(duration), { description: "a finite duration" })), {
	strict: true,
	decode: (i) => succeed(require_Layer.nanos(i)),
	encode: (a, _, ast) => require_Layer.match(require_Layer.toNanos(a), {
		onNone: () => fail(new Type(ast, a, `Unable to encode ${a} into a bigint`)),
		onSome: (nanos) => succeed(nanos)
	})
}).annotations({ identifier: "DurationFromNanos" });
/**
* A non-negative integer. +Infinity is excluded.
*
* @category number constructors
* @since 3.11.10
*/
var NonNegativeInt = /* @__PURE__ */ NonNegative.pipe(int()).annotations({ identifier: "NonNegativeInt" });
transform(NonNegative.annotations({ description: "a non-negative number to be decoded into a Duration" }), DurationFromSelf, {
	strict: true,
	decode: (i) => require_Layer.millis(i),
	encode: (a) => require_Layer.toMillis(a)
}).annotations({ identifier: "DurationFromMillis" });
var DurationValueMillis = /* @__PURE__ */ TaggedStruct("Millis", { millis: NonNegativeInt });
var DurationValueNanos = /* @__PURE__ */ TaggedStruct("Nanos", { nanos: BigInt$ });
var DurationValueInfinity = /* @__PURE__ */ TaggedStruct("Infinity", {});
var durationValueInfinity = /* @__PURE__ */ DurationValueInfinity.make({});
var DurationValue = /* @__PURE__ */ Union(DurationValueMillis, DurationValueNanos, DurationValueInfinity).annotations({
	identifier: "DurationValue",
	description: "an JSON-compatible tagged union to be decoded into a Duration"
});
var HRTime = /* @__PURE__ */ Union(/* @__PURE__ */ Tuple(element(NonNegativeInt).annotations({ title: "seconds" }), element(NonNegativeInt).annotations({ title: "nanos" })).annotations({ identifier: "FiniteHRTime" }), /* @__PURE__ */ Tuple(Literal(-1), Literal(0)).annotations({ identifier: "InfiniteHRTime" })).annotations({
	identifier: "HRTime",
	description: "a tuple of seconds and nanos to be decoded into a Duration"
});
var isDurationValue = (u) => typeof u === "object";
transform(Union(DurationValue, HRTime), DurationFromSelf, {
	strict: true,
	decode: (i) => {
		if (isDurationValue(i)) switch (i._tag) {
			case "Millis": return require_Layer.millis(i.millis);
			case "Nanos": return require_Layer.nanos(i.nanos);
			case "Infinity": return require_Layer.infinity;
		}
		const [seconds, nanos$1] = i;
		return seconds === -1 ? require_Layer.infinity : require_Layer.nanos(BigInt(seconds) * BigInt(1e9) + BigInt(nanos$1));
	},
	encode: (a) => {
		switch (a.value._tag) {
			case "Millis": return DurationValueMillis.make({ millis: a.value.millis });
			case "Nanos": return DurationValueNanos.make({ nanos: a.value.nanos });
			case "Infinity": return durationValueInfinity;
		}
	}
}).annotations({ identifier: "Duration" });
/**
* @category Uint8Array constructors
* @since 3.10.0
*/
var Uint8ArrayFromSelf = class extends declare(require_Layer.isUint8Array, {
	typeConstructor: { _tag: "Uint8Array" },
	identifier: "Uint8ArrayFromSelf",
	pretty: () => (u8arr) => `new Uint8Array(${JSON.stringify(Array.from(u8arr))})`,
	arbitrary: () => (fc) => fc.uint8Array(),
	equivalence: () => require_Layer.getEquivalence(require_Layer.equals)
}) {};
/**
* @category number constructors
* @since 3.11.10
*/
var Uint8 = class extends Number$.pipe(/* @__PURE__ */ between(0, 255, {
	identifier: "Uint8",
	description: "a 8-bit unsigned integer"
})) {};
transform(Array$(Uint8).annotations({ description: "an array of 8-bit unsigned integers to be decoded into a Uint8Array" }), Uint8ArrayFromSelf, {
	strict: true,
	decode: (i) => Uint8Array.from(i),
	encode: (a) => Array.from(a)
}).annotations({ identifier: "Uint8Array" });
/**
* @category schema id
* @since 3.10.0
*/
var ValidDateSchemaId = /* @__PURE__ */ Symbol.for("effect/SchemaId/ValidDate");
/**
* Defines a filter that specifically rejects invalid dates, such as `new
* Date("Invalid Date")`. This filter ensures that only properly formatted and
* valid date objects are accepted, enhancing data integrity by preventing
* erroneous date values from being processed.
*
* @category Date filters
* @since 3.10.0
*/
var validDate = (annotations) => (self) => self.pipe(filter((a) => !Number.isNaN(a.getTime()), {
	schemaId: ValidDateSchemaId,
	[ValidDateSchemaId]: { noInvalidDate: true },
	title: "validDate",
	description: "a valid Date",
	...annotations
}));
/**
* @category schema id
* @since 3.11.8
*/
var DateFromSelfSchemaId = DateFromSelfSchemaId$1;
/**
* Describes a schema that accommodates potentially invalid `Date` instances,
* such as `new Date("Invalid Date")`, without rejection.
*
* @category Date constructors
* @since 3.10.0
*/
var DateFromSelf = class extends declare(require_Layer.isDate, {
	typeConstructor: { _tag: "Date" },
	identifier: "DateFromSelf",
	schemaId: DateFromSelfSchemaId,
	[DateFromSelfSchemaId]: { noInvalidDate: false },
	description: "a potentially invalid Date instance",
	pretty: () => (date) => `new Date(${JSON.stringify(date)})`,
	arbitrary: () => (fc) => fc.date({ noInvalidDate: false }),
	equivalence: () => require_Layer.Date
}) {};
DateFromSelf.pipe(/* @__PURE__ */ validDate({
	identifier: "ValidDateFromSelf",
	description: "a valid Date instance"
}));
/**
* Defines a schema that attempts to convert a `string` to a `Date` object using
* the `new Date` constructor. This conversion is lenient, meaning it does not
* reject strings that do not form valid dates (e.g., using `new Date("Invalid
* Date")` results in a `Date` object, despite being invalid).
*
* @category Date transformations
* @since 3.10.0
*/
var DateFromString = class extends transform(String$.annotations({ description: "a string to be decoded into a Date" }), DateFromSelf, {
	strict: true,
	decode: (i) => new Date(i),
	encode: (a) => require_Layer.formatDate(a)
}).annotations({ identifier: "DateFromString" }) {};
DateFromString.pipe(/* @__PURE__ */ validDate({ identifier: "Date" }));
transform(Number$.annotations({ description: "a number to be decoded into a Date" }), DateFromSelf, {
	strict: true,
	decode: (i) => new Date(i),
	encode: (a) => a.getTime()
}).annotations({ identifier: "DateFromNumber" });
/**
* Describes a schema that represents a `DateTime.Utc` instance.
*
* @category DateTime.Utc constructors
* @since 3.10.0
*/
var DateTimeUtcFromSelf = class extends declare((u) => isDateTime(u) && isUtc(u), {
	typeConstructor: { _tag: "effect/DateTime.Utc" },
	identifier: "DateTimeUtcFromSelf",
	description: "a DateTime.Utc instance",
	pretty: () => (dateTime) => dateTime.toString(),
	arbitrary: () => (fc) => fc.date({ noInvalidDate: true }).map((date) => unsafeFromDate(date)),
	equivalence: () => Equivalence
}) {};
var decodeDateTimeUtc = (input, ast) => _try({
	try: () => unsafeMake(input),
	catch: () => new Type(ast, input, `Unable to decode ${require_Layer.formatUnknown(input)} into a DateTime.Utc`)
});
transformOrFail(Number$.annotations({ description: "a number to be decoded into a DateTime.Utc" }), DateTimeUtcFromSelf, {
	strict: true,
	decode: (i, _, ast) => decodeDateTimeUtc(i, ast),
	encode: (a) => succeed(toEpochMillis(a))
}).annotations({ identifier: "DateTimeUtcFromNumber" });
transformOrFail(DateFromSelf.annotations({ description: "a Date to be decoded into a DateTime.Utc" }), DateTimeUtcFromSelf, {
	strict: true,
	decode: (i, _, ast) => decodeDateTimeUtc(i, ast),
	encode: (a) => succeed(toDateUtc(a))
}).annotations({ identifier: "DateTimeUtcFromDate" });
transformOrFail(String$.annotations({ description: "a string to be decoded into a DateTime.Utc" }), DateTimeUtcFromSelf, {
	strict: true,
	decode: (i, _, ast) => decodeDateTimeUtc(i, ast),
	encode: (a) => succeed(formatIso(a))
}).annotations({ identifier: "DateTimeUtc" });
var timeZoneOffsetArbitrary = () => (fc) => fc.integer({
	min: -720 * 60 * 1e3,
	max: 840 * 60 * 1e3
}).map(zoneMakeOffset);
/**
* Describes a schema that represents a `TimeZone.Offset` instance.
*
* @category TimeZone constructors
* @since 3.10.0
*/
var TimeZoneOffsetFromSelf = class extends declare(isTimeZoneOffset, {
	typeConstructor: { _tag: "effect/DateTime.TimeZone.Offset" },
	identifier: "TimeZoneOffsetFromSelf",
	description: "a TimeZone.Offset instance",
	pretty: () => (zone) => zone.toString(),
	arbitrary: timeZoneOffsetArbitrary
}) {};
transform(Number$.annotations({ description: "a number to be decoded into a TimeZone.Offset" }), TimeZoneOffsetFromSelf, {
	strict: true,
	decode: (i) => zoneMakeOffset(i),
	encode: (a) => a.offset
}).annotations({ identifier: "TimeZoneOffset" });
var timeZoneNamedArbitrary = () => (fc) => fc.constantFrom(...Intl.supportedValuesOf("timeZone")).map(zoneUnsafeMakeNamed);
/**
* Describes a schema that represents a `TimeZone.Named` instance.
*
* @category TimeZone constructors
* @since 3.10.0
*/
var TimeZoneNamedFromSelf = class extends declare(isTimeZoneNamed, {
	typeConstructor: { _tag: "effect/DateTime.TimeZone.Named" },
	identifier: "TimeZoneNamedFromSelf",
	description: "a TimeZone.Named instance",
	pretty: () => (zone) => zone.toString(),
	arbitrary: timeZoneNamedArbitrary
}) {};
transformOrFail(String$.annotations({ description: "a string to be decoded into a TimeZone.Named" }), TimeZoneNamedFromSelf, {
	strict: true,
	decode: (i, _, ast) => _try({
		try: () => zoneUnsafeMakeNamed(i),
		catch: () => new Type(ast, i, `Unable to decode ${JSON.stringify(i)} into a TimeZone.Named`)
	}),
	encode: (a) => succeed(a.id)
}).annotations({ identifier: "TimeZoneNamed" });
/**
* @category TimeZone constructors
* @since 3.10.0
*/
var TimeZoneFromSelf = class extends Union(TimeZoneOffsetFromSelf, TimeZoneNamedFromSelf) {};
transformOrFail(String$.annotations({ description: "a string to be decoded into a TimeZone" }), TimeZoneFromSelf, {
	strict: true,
	decode: (i, _, ast) => require_Layer.match(zoneFromString(i), {
		onNone: () => fail(new Type(ast, i, `Unable to decode ${JSON.stringify(i)} into a TimeZone`)),
		onSome: succeed
	}),
	encode: (a) => succeed(zoneToString(a))
}).annotations({ identifier: "TimeZone" });
var timeZoneArbitrary = (fc) => fc.oneof(timeZoneOffsetArbitrary()(fc), timeZoneNamedArbitrary()(fc));
/**
* Describes a schema that represents a `DateTime.Zoned` instance.
*
* @category DateTime.Zoned constructors
* @since 3.10.0
*/
var DateTimeZonedFromSelf = class extends declare((u) => isDateTime(u) && isZoned(u), {
	typeConstructor: { _tag: "effect/DateTime.Zoned" },
	identifier: "DateTimeZonedFromSelf",
	description: "a DateTime.Zoned instance",
	pretty: () => (dateTime) => dateTime.toString(),
	arbitrary: () => (fc) => fc.tuple(fc.integer({
		min: -31536e9,
		max: 31536e9
	}), timeZoneArbitrary(fc)).map(([millis, timeZone]) => unsafeMakeZoned(millis, { timeZone })),
	equivalence: () => Equivalence
}) {};
transformOrFail(String$.annotations({ description: "a string to be decoded into a DateTime.Zoned" }), DateTimeZonedFromSelf, {
	strict: true,
	decode: (i, _, ast) => require_Layer.match(makeZonedFromString(i), {
		onNone: () => fail(new Type(ast, i, `Unable to decode ${JSON.stringify(i)} into a DateTime.Zoned`)),
		onSome: succeed
	}),
	encode: (a) => succeed(formatIsoZoned(a))
}).annotations({ identifier: "DateTimeZoned" });
var optionDecode = (input) => input._tag === "None" ? require_Layer.none$1() : require_Layer.some(input.value);
var optionArbitrary = (value, ctx) => (fc) => fc.oneof(ctx, fc.record({ _tag: fc.constant("None") }), fc.record({
	_tag: fc.constant("Some"),
	value: value(fc)
})).map(optionDecode);
var optionPretty = (value) => require_Layer.match({
	onNone: () => "none()",
	onSome: (a) => `some(${value(a)})`
});
var optionParse = (decodeUnknown) => (u, options, ast) => require_Layer.isOption(u) ? require_Layer.isNone(u) ? succeed(require_Layer.none$1()) : toComposite(decodeUnknown(u.value, options), require_Layer.some, ast, u) : fail(new Type(ast, u));
var OptionFromSelf_ = (value) => {
	return declare([value], {
		decode: (value) => optionParse(decodeUnknown(value)),
		encode: (value) => optionParse(encodeUnknown(value))
	}, {
		typeConstructor: { _tag: "effect/Option" },
		pretty: optionPretty,
		arbitrary: optionArbitrary,
		equivalence: require_Layer.getEquivalence$1
	});
};
/**
* @category Option transformations
* @since 3.10.0
*/
var OptionFromSelf = (value) => {
	return OptionFromSelf_(value).annotations({ description: `Option<${format(value)}>` });
};
transform(String$, /* @__PURE__ */ OptionFromSelf(NonEmptyTrimmedString), {
	strict: true,
	decode: (i) => require_Layer.filter(require_Layer.some(i.trim()), isNonEmpty),
	encode: (a) => require_Layer.getOrElse(a, () => "")
});
var bigDecimalPretty = () => (val) => `BigDecimal(${format$1(normalize(val))})`;
var bigDecimalArbitrary = () => (fc) => fc.tuple(fc.bigInt(), fc.integer({
	min: -18,
	max: 18
})).map(([value, scale]) => make$1(value, scale));
/**
* @category BigDecimal constructors
* @since 3.10.0
*/
var BigDecimalFromSelf = class extends declare(isBigDecimal, {
	typeConstructor: { _tag: "effect/BigDecimal" },
	identifier: "BigDecimalFromSelf",
	pretty: bigDecimalPretty,
	arbitrary: bigDecimalArbitrary,
	equivalence: () => Equivalence$2
}) {};
transformOrFail(String$.annotations({ description: "a string to be decoded into a BigDecimal" }), BigDecimalFromSelf, {
	strict: true,
	decode: (i, _, ast) => fromString$1(i).pipe(require_Layer.match({
		onNone: () => fail(new Type(ast, i, `Unable to decode ${JSON.stringify(i)} into a BigDecimal`)),
		onSome: (val) => succeed(normalize(val))
	})),
	encode: (a) => succeed(format$1(normalize(a)))
}).annotations({ identifier: "BigDecimal" });
transform(Number$.annotations({ description: "a number to be decoded into a BigDecimal" }), BigDecimalFromSelf, {
	strict: true,
	decode: (i) => unsafeFromNumber(i),
	encode: (a) => unsafeToNumber(a)
}).annotations({ identifier: "BigDecimalFromNumber" });
function getDisableValidationMakeOption(options) {
	return require_Layer.isBoolean(options) ? options : options?.disableValidation ?? false;
}
var FiberIdEncoded = /* @__PURE__ */ Union(/* @__PURE__ */ Struct({ _tag: Literal("None") }).annotations({ identifier: "FiberIdNoneEncoded" }), /* @__PURE__ */ Struct({
	_tag: Literal("Runtime"),
	id: Int,
	startTimeMillis: Int
}).annotations({ identifier: "FiberIdRuntimeEncoded" }), /* @__PURE__ */ Struct({
	_tag: Literal("Composite"),
	left: suspend(() => FiberIdEncoded),
	right: suspend(() => FiberIdEncoded)
}).annotations({ identifier: "FiberIdCompositeEncoded" })).annotations({ identifier: "FiberIdEncoded" });
var fiberIdArbitrary = (fc) => fc.letrec((tie) => ({
	None: fc.record({ _tag: fc.constant("None") }),
	Runtime: fc.record({
		_tag: fc.constant("Runtime"),
		id: fc.integer(),
		startTimeMillis: fc.integer()
	}),
	Composite: fc.record({
		_tag: fc.constant("Composite"),
		left: tie("FiberId"),
		right: tie("FiberId")
	}),
	FiberId: fc.oneof(tie("None"), tie("Runtime"), tie("Composite"))
})).FiberId.map(fiberIdDecode);
var fiberIdPretty = (fiberId) => {
	switch (fiberId._tag) {
		case "None": return "FiberId.none";
		case "Runtime": return `FiberId.runtime(${fiberId.id}, ${fiberId.startTimeMillis})`;
		case "Composite": return `FiberId.composite(${fiberIdPretty(fiberId.right)}, ${fiberIdPretty(fiberId.left)})`;
	}
};
/**
* @category FiberId constructors
* @since 3.10.0
*/
var FiberIdFromSelf = class extends declare(require_Layer.isFiberId, {
	typeConstructor: { _tag: "effect/FiberId" },
	identifier: "FiberIdFromSelf",
	pretty: () => fiberIdPretty,
	arbitrary: () => fiberIdArbitrary
}) {};
var fiberIdDecode = (input) => {
	switch (input._tag) {
		case "None": return require_Layer.none;
		case "Runtime": return require_Layer.runtime(input.id, input.startTimeMillis);
		case "Composite": return require_Layer.composite(fiberIdDecode(input.left), fiberIdDecode(input.right));
	}
};
var fiberIdEncode = (input) => {
	switch (input._tag) {
		case "None": return { _tag: "None" };
		case "Runtime": return {
			_tag: "Runtime",
			id: input.id,
			startTimeMillis: input.startTimeMillis
		};
		case "Composite": return {
			_tag: "Composite",
			left: fiberIdEncode(input.left),
			right: fiberIdEncode(input.right)
		};
	}
};
transform(FiberIdEncoded, FiberIdFromSelf, {
	strict: true,
	decode: (i) => fiberIdDecode(i),
	encode: (a) => fiberIdEncode(a)
}).annotations({ identifier: "FiberId" });
transform(Unknown, Unknown, {
	strict: true,
	decode: (i) => {
		if (require_Layer.isObject(i) && "message" in i && typeof i.message === "string") {
			const err = new Error(i.message, { cause: i });
			if ("name" in i && typeof i.name === "string") err.name = i.name;
			err.stack = "stack" in i && typeof i.stack === "string" ? i.stack : "";
			return err;
		}
		return require_Layer.prettyErrorMessage(i);
	},
	encode: (a) => {
		if (a instanceof Error) return {
			name: a.name,
			message: a.message
		};
		return require_Layer.prettyErrorMessage(a);
	}
}).annotations({ identifier: "Defect" });
transform(Unknown, Boolean$, {
	strict: true,
	decode: (i) => require_Layer.isTruthy(i),
	encode: require_Layer.identity
}).annotations({ identifier: "BooleanFromUnknown" });
transform(Literal("true", "false").annotations({ description: "a string to be decoded into a boolean" }), Boolean$, {
	strict: true,
	decode: (i) => i === "true",
	encode: (a) => a ? "true" : "false"
}).annotations({ identifier: "BooleanFromString" });
var SymbolStruct = /* @__PURE__ */ TaggedStruct("symbol", { key: String$ }).annotations({ description: "an object to be decoded into a globally shared symbol" });
var SymbolFromStruct = /* @__PURE__ */ transformOrFail(SymbolStruct, SymbolFromSelf, {
	strict: true,
	decode: (i) => decodeSymbol(i.key),
	encode: (a, _, ast) => map(encodeSymbol(a, ast), (key) => SymbolStruct.make({ key }))
});
/** @ignore */
var PropertyKey$ = class extends Union(String$, Number$, SymbolFromStruct).annotations({ identifier: "PropertyKey" }) {};
Struct({
	_tag: propertySignature(Literal("Pointer", "Unexpected", "Missing", "Composite", "Refinement", "Transformation", "Type", "Forbidden")).annotations({ description: "The tag identifying the type of parse issue" }),
	path: propertySignature(Array$(PropertyKey$)).annotations({ description: "The path to the property where the issue occurred" }),
	message: propertySignature(String$).annotations({ description: "A descriptive message explaining the issue" })
}).annotations({
	identifier: "ArrayFormatterIssue",
	description: "Represents an issue returned by the ArrayFormatter formatter"
});
//#endregion
//#region src/shared/rpc.ts
var JsonRpcErrorSchema = Struct({
	code: Number$,
	message: String$
});
var JsonRpcMessageSchema = Union(Struct({
	jsonrpc: Literal("2.0"),
	id: optional(Union(Number$, String$, Null)),
	method: String$,
	params: optional(Unknown)
}), Struct({
	jsonrpc: Literal("2.0"),
	id: Union(Number$, String$, Null),
	result: optional(Unknown),
	error: optional(JsonRpcErrorSchema)
}));
function parseJsonRpcMessage(value) {
	const decoded = decodeUnknownEither(JsonRpcMessageSchema)(value);
	if (require_Layer.isLeft(decoded)) throw new Error("Invalid JSON-RPC 2.0 message");
	return decoded.right;
}
function isJsonRpcRequest(message) {
	return "method" in message;
}
//#endregion
Object.defineProperty(exports, "isJsonRpcRequest", {
	enumerable: true,
	get: function() {
		return isJsonRpcRequest;
	}
});
Object.defineProperty(exports, "parseJsonRpcMessage", {
	enumerable: true,
	get: function() {
		return parseJsonRpcMessage;
	}
});
