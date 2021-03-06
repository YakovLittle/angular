import {Injectable} from 'angular2/src/di/decorators';
import {isBlank, isPresent, BaseException, StringWrapper} from 'angular2/src/facade/lang';
import {ListWrapper, List} from 'angular2/src/facade/collection';
import {
  Lexer,
  EOF,
  Token,
  $PERIOD,
  $COLON,
  $SEMICOLON,
  $LBRACKET,
  $RBRACKET,
  $COMMA,
  $LBRACE,
  $RBRACE,
  $LPAREN,
  $RPAREN
} from './lexer';
import {reflector, Reflector} from 'angular2/src/reflection/reflection';
import {
  AST,
  EmptyExpr,
  ImplicitReceiver,
  AccessMember,
  SafeAccessMember,
  LiteralPrimitive,
  Binary,
  PrefixNot,
  Conditional,
  If,
  BindingPipe,
  Assignment,
  Chain,
  KeyedAccess,
  LiteralArray,
  LiteralMap,
  Interpolation,
  MethodCall,
  SafeMethodCall,
  FunctionCall,
  TemplateBinding,
  ASTWithSource,
  AstVisitor
} from './ast';


var _implicitReceiver = new ImplicitReceiver();
// TODO(tbosch): Cannot make this const/final right now because of the transpiler...
var INTERPOLATION_REGEXP = /\{\{(.*?)\}\}/g;

@Injectable()
export class Parser {
  _reflector: Reflector;

  constructor(public _lexer: Lexer, providedReflector: Reflector = null) {
    this._reflector = isPresent(providedReflector) ? providedReflector : reflector;
  }

  parseAction(input: string, location: any): ASTWithSource {
    var tokens = this._lexer.tokenize(input);
    var ast = new _ParseAST(input, location, tokens, this._reflector, true).parseChain();
    return new ASTWithSource(ast, input, location);
  }

  parseBinding(input: string, location: any): ASTWithSource {
    var tokens = this._lexer.tokenize(input);
    var ast = new _ParseAST(input, location, tokens, this._reflector, false).parseChain();
    return new ASTWithSource(ast, input, location);
  }

  parseSimpleBinding(input: string, location: string): ASTWithSource {
    var tokens = this._lexer.tokenize(input);
    var ast = new _ParseAST(input, location, tokens, this._reflector, false).parseSimpleBinding();
    return new ASTWithSource(ast, input, location);
  }

  parseTemplateBindings(input: string, location: any): List<TemplateBinding> {
    var tokens = this._lexer.tokenize(input);
    return new _ParseAST(input, location, tokens, this._reflector, false).parseTemplateBindings();
  }

  parseInterpolation(input: string, location: any): ASTWithSource {
    var parts = StringWrapper.split(input, INTERPOLATION_REGEXP);
    if (parts.length <= 1) {
      return null;
    }
    var strings = [];
    var expressions = [];

    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (i % 2 === 0) {
        // fixed string
        strings.push(part);
      } else {
        var tokens = this._lexer.tokenize(part);
        var ast = new _ParseAST(input, location, tokens, this._reflector, false).parseChain();
        expressions.push(ast);
      }
    }
    return new ASTWithSource(new Interpolation(strings, expressions), input, location);
  }

  wrapLiteralPrimitive(input: string, location: any): ASTWithSource {
    return new ASTWithSource(new LiteralPrimitive(input), input, location);
  }
}

class _ParseAST {
  index: int = 0;
  constructor(public input: string, public location: any, public tokens: List<any>,
              public reflector: Reflector, public parseAction: boolean) {}

  peek(offset: int): Token {
    var i = this.index + offset;
    return i < this.tokens.length ? this.tokens[i] : EOF;
  }

  get next(): Token { return this.peek(0); }

  get inputIndex(): int {
    return (this.index < this.tokens.length) ? this.next.index : this.input.length;
  }

  advance() { this.index++; }

  optionalCharacter(code: int): boolean {
    if (this.next.isCharacter(code)) {
      this.advance();
      return true;
    } else {
      return false;
    }
  }

  optionalKeywordVar(): boolean {
    if (this.peekKeywordVar()) {
      this.advance();
      return true;
    } else {
      return false;
    }
  }

  peekKeywordVar(): boolean { return this.next.isKeywordVar() || this.next.isOperator('#'); }

  expectCharacter(code: int) {
    if (this.optionalCharacter(code)) return;
    this.error(`Missing expected ${StringWrapper.fromCharCode(code)}`);
  }


  optionalOperator(op: string): boolean {
    if (this.next.isOperator(op)) {
      this.advance();
      return true;
    } else {
      return false;
    }
  }

  expectOperator(operator: string) {
    if (this.optionalOperator(operator)) return;
    this.error(`Missing expected operator ${operator}`);
  }

  expectIdentifierOrKeyword(): string {
    var n = this.next;
    if (!n.isIdentifier() && !n.isKeyword()) {
      this.error(`Unexpected token ${n}, expected identifier or keyword`);
    }
    this.advance();
    return n.toString();
  }

  expectIdentifierOrKeywordOrString(): string {
    var n = this.next;
    if (!n.isIdentifier() && !n.isKeyword() && !n.isString()) {
      this.error(`Unexpected token ${n}, expected identifier, keyword, or string`);
    }
    this.advance();
    return n.toString();
  }

  parseChain(): AST {
    var exprs = [];
    while (this.index < this.tokens.length) {
      var expr = this.parsePipe();
      exprs.push(expr);

      if (this.optionalCharacter($SEMICOLON)) {
        if (!this.parseAction) {
          this.error("Binding expression cannot contain chained expression");
        }
        while (this.optionalCharacter($SEMICOLON)) {
        }  // read all semicolons
      } else if (this.index < this.tokens.length) {
        this.error(`Unexpected token '${this.next}'`);
      }
    }
    if (exprs.length == 0) return new EmptyExpr();
    if (exprs.length == 1) return exprs[0];
    return new Chain(exprs);
  }

  parseSimpleBinding(): AST {
    var ast = this.parseChain();
    if (!SimpleExpressionChecker.check(ast)) {
      this.error(`Simple binding expression can only contain field access and constants'`);
    }
    return ast;
  }

  parsePipe(): AST {
    var result = this.parseExpression();
    if (this.optionalOperator("|")) {
      if (this.parseAction) {
        this.error("Cannot have a pipe in an action expression");
      }

      do {
        var name = this.expectIdentifierOrKeyword();
        var args = [];
        while (this.optionalCharacter($COLON)) {
          args.push(this.parsePipe());
        }
        result = new BindingPipe(result, name, args);
      } while (this.optionalOperator("|"));
    }

    return result;
  }

  parseExpression(): AST {
    var start = this.inputIndex;
    var result = this.parseConditional();

    while (this.next.isOperator('=')) {
      if (!result.isAssignable) {
        var end = this.inputIndex;
        var expression = this.input.substring(start, end);
        this.error(`Expression ${expression} is not assignable`);
      }

      if (!this.parseAction) {
        this.error("Binding expression cannot contain assignments");
      }

      this.expectOperator('=');
      result = new Assignment(result, this.parseConditional());
    }

    return result;
  }

  parseConditional(): AST {
    var start = this.inputIndex;
    var result = this.parseLogicalOr();

    if (this.optionalOperator('?')) {
      var yes = this.parsePipe();
      if (!this.optionalCharacter($COLON)) {
        var end = this.inputIndex;
        var expression = this.input.substring(start, end);
        this.error(`Conditional expression ${expression} requires all 3 expressions`);
      }
      var no = this.parsePipe();
      return new Conditional(result, yes, no);
    } else {
      return result;
    }
  }

  parseLogicalOr(): AST {
    // '||'
    var result = this.parseLogicalAnd();
    while (this.optionalOperator('||')) {
      result = new Binary('||', result, this.parseLogicalAnd());
    }
    return result;
  }

  parseLogicalAnd(): AST {
    // '&&'
    var result = this.parseEquality();
    while (this.optionalOperator('&&')) {
      result = new Binary('&&', result, this.parseEquality());
    }
    return result;
  }

  parseEquality(): AST {
    // '==','!=','===','!=='
    var result = this.parseRelational();
    while (true) {
      if (this.optionalOperator('==')) {
        result = new Binary('==', result, this.parseRelational());
      } else if (this.optionalOperator('===')) {
        result = new Binary('===', result, this.parseRelational());
      } else if (this.optionalOperator('!=')) {
        result = new Binary('!=', result, this.parseRelational());
      } else if (this.optionalOperator('!==')) {
        result = new Binary('!==', result, this.parseRelational());
      } else {
        return result;
      }
    }
  }

  parseRelational(): AST {
    // '<', '>', '<=', '>='
    var result = this.parseAdditive();
    while (true) {
      if (this.optionalOperator('<')) {
        result = new Binary('<', result, this.parseAdditive());
      } else if (this.optionalOperator('>')) {
        result = new Binary('>', result, this.parseAdditive());
      } else if (this.optionalOperator('<=')) {
        result = new Binary('<=', result, this.parseAdditive());
      } else if (this.optionalOperator('>=')) {
        result = new Binary('>=', result, this.parseAdditive());
      } else {
        return result;
      }
    }
  }

  parseAdditive(): AST {
    // '+', '-'
    var result = this.parseMultiplicative();
    while (true) {
      if (this.optionalOperator('+')) {
        result = new Binary('+', result, this.parseMultiplicative());
      } else if (this.optionalOperator('-')) {
        result = new Binary('-', result, this.parseMultiplicative());
      } else {
        return result;
      }
    }
  }

  parseMultiplicative(): AST {
    // '*', '%', '/'
    var result = this.parsePrefix();
    while (true) {
      if (this.optionalOperator('*')) {
        result = new Binary('*', result, this.parsePrefix());
      } else if (this.optionalOperator('%')) {
        result = new Binary('%', result, this.parsePrefix());
      } else if (this.optionalOperator('/')) {
        result = new Binary('/', result, this.parsePrefix());
      } else {
        return result;
      }
    }
  }

  parsePrefix(): AST {
    if (this.optionalOperator('+')) {
      return this.parsePrefix();
    } else if (this.optionalOperator('-')) {
      return new Binary('-', new LiteralPrimitive(0), this.parsePrefix());
    } else if (this.optionalOperator('!')) {
      return new PrefixNot(this.parsePrefix());
    } else {
      return this.parseCallChain();
    }
  }

  parseCallChain(): AST {
    var result = this.parsePrimary();
    while (true) {
      if (this.optionalCharacter($PERIOD)) {
        result = this.parseAccessMemberOrMethodCall(result, false);

      } else if (this.optionalOperator('?.')) {
        result = this.parseAccessMemberOrMethodCall(result, true);

      } else if (this.optionalCharacter($LBRACKET)) {
        var key = this.parsePipe();
        this.expectCharacter($RBRACKET);
        result = new KeyedAccess(result, key);

      } else if (this.optionalCharacter($LPAREN)) {
        var args = this.parseCallArguments();
        this.expectCharacter($RPAREN);
        result = new FunctionCall(result, args);

      } else {
        return result;
      }
    }
  }

  parsePrimary(): AST {
    if (this.optionalCharacter($LPAREN)) {
      let result = this.parsePipe();
      this.expectCharacter($RPAREN);
      return result;
    } else if (this.next.isKeywordNull() || this.next.isKeywordUndefined()) {
      this.advance();
      return new LiteralPrimitive(null);

    } else if (this.next.isKeywordTrue()) {
      this.advance();
      return new LiteralPrimitive(true);

    } else if (this.next.isKeywordFalse()) {
      this.advance();
      return new LiteralPrimitive(false);

    } else if (this.parseAction && this.next.isKeywordIf()) {
      this.advance();
      this.expectCharacter($LPAREN);
      let condition = this.parseExpression();
      this.expectCharacter($RPAREN);
      let ifExp = this.parseExpressionOrBlock();
      let elseExp;
      if (this.next.isKeywordElse()) {
        this.advance();
        elseExp = this.parseExpressionOrBlock();
      }
      return new If(condition, ifExp, elseExp);

    } else if (this.optionalCharacter($LBRACKET)) {
      var elements = this.parseExpressionList($RBRACKET);
      this.expectCharacter($RBRACKET);
      return new LiteralArray(elements);

    } else if (this.next.isCharacter($LBRACE)) {
      return this.parseLiteralMap();

    } else if (this.next.isIdentifier()) {
      return this.parseAccessMemberOrMethodCall(_implicitReceiver, false);

    } else if (this.next.isNumber()) {
      var value = this.next.toNumber();
      this.advance();
      return new LiteralPrimitive(value);

    } else if (this.next.isString()) {
      var literalValue = this.next.toString();
      this.advance();
      return new LiteralPrimitive(literalValue);

    } else if (this.index >= this.tokens.length) {
      this.error(`Unexpected end of expression: ${this.input}`);

    } else {
      this.error(`Unexpected token ${this.next}`);
    }
    // error() throws, so we don't reach here.
    throw new BaseException("Fell through all cases in parsePrimary");
  }

  parseExpressionList(terminator: int): List<any> {
    var result = [];
    if (!this.next.isCharacter(terminator)) {
      do {
        result.push(this.parsePipe());
      } while (this.optionalCharacter($COMMA));
    }
    return result;
  }

  parseLiteralMap(): LiteralMap {
    var keys = [];
    var values = [];
    this.expectCharacter($LBRACE);
    if (!this.optionalCharacter($RBRACE)) {
      do {
        var key = this.expectIdentifierOrKeywordOrString();
        keys.push(key);
        this.expectCharacter($COLON);
        values.push(this.parsePipe());
      } while (this.optionalCharacter($COMMA));
      this.expectCharacter($RBRACE);
    }
    return new LiteralMap(keys, values);
  }

  parseAccessMemberOrMethodCall(receiver: AST, isSafe: boolean = false): AST {
    let id = this.expectIdentifierOrKeyword();

    if (this.optionalCharacter($LPAREN)) {
      let args = this.parseCallArguments();
      this.expectCharacter($RPAREN);
      let fn = this.reflector.method(id);
      return isSafe ? new SafeMethodCall(receiver, id, fn, args) :
                      new MethodCall(receiver, id, fn, args);

    } else {
      let getter = this.reflector.getter(id);
      let setter = this.reflector.setter(id);
      return isSafe ? new SafeAccessMember(receiver, id, getter, setter) :
                      new AccessMember(receiver, id, getter, setter);
    }
  }

  parseCallArguments(): BindingPipe[] {
    if (this.next.isCharacter($RPAREN)) return [];
    var positionals = [];
    do {
      positionals.push(this.parsePipe());
    } while (this.optionalCharacter($COMMA));
    return positionals;
  }

  parseExpressionOrBlock(): AST {
    if (this.optionalCharacter($LBRACE)) {
      let block = this.parseBlockContent();
      this.expectCharacter($RBRACE);
      return block;
    }

    return this.parseExpression();
  }

  parseBlockContent(): AST {
    if (!this.parseAction) {
      this.error("Binding expression cannot contain chained expression");
    }
    var exprs = [];
    while (this.index < this.tokens.length && !this.next.isCharacter($RBRACE)) {
      var expr = this.parseExpression();
      exprs.push(expr);

      if (this.optionalCharacter($SEMICOLON)) {
        while (this.optionalCharacter($SEMICOLON)) {
        }  // read all semicolons
      }
    }
    if (exprs.length == 0) return new EmptyExpr();
    if (exprs.length == 1) return exprs[0];

    return new Chain(exprs);
  }


  /**
   * An identifier, a keyword, a string with an optional `-` inbetween.
   */
  expectTemplateBindingKey(): string {
    var result = '';
    var operatorFound = false;
    do {
      result += this.expectIdentifierOrKeywordOrString();
      operatorFound = this.optionalOperator('-');
      if (operatorFound) {
        result += '-';
      }
    } while (operatorFound);

    return result.toString();
  }

  parseTemplateBindings(): any[] {
    var bindings = [];
    var prefix = null;
    while (this.index < this.tokens.length) {
      var keyIsVar: boolean = this.optionalKeywordVar();
      var key = this.expectTemplateBindingKey();
      if (!keyIsVar) {
        if (prefix == null) {
          prefix = key;
        } else {
          key = prefix + '-' + key;
        }
      }
      this.optionalCharacter($COLON);
      var name = null;
      var expression = null;
      if (keyIsVar) {
        if (this.optionalOperator("=")) {
          name = this.expectTemplateBindingKey();
        } else {
          name = '\$implicit';
        }
      } else if (this.next !== EOF && !this.peekKeywordVar()) {
        var start = this.inputIndex;
        var ast = this.parsePipe();
        var source = this.input.substring(start, this.inputIndex);
        expression = new ASTWithSource(ast, source, this.location);
      }
      bindings.push(new TemplateBinding(key, keyIsVar, name, expression));
      if (!this.optionalCharacter($SEMICOLON)) {
        this.optionalCharacter($COMMA);
      }
    }
    return bindings;
  }

  error(message: string, index: int = null) {
    if (isBlank(index)) index = this.index;

    var location = (index < this.tokens.length) ? `at column ${this.tokens[index].index + 1} in` :
                                                  `at the end of the expression`;

    throw new BaseException(
        `Parser Error: ${message} ${location} [${this.input}] in ${this.location}`);
  }
}

class SimpleExpressionChecker implements AstVisitor {
  static check(ast: AST): boolean {
    var s = new SimpleExpressionChecker();
    ast.visit(s);
    return s.simple;
  }

  simple = true;

  visitImplicitReceiver(ast: ImplicitReceiver) {}

  visitInterpolation(ast: Interpolation) { this.simple = false; }

  visitLiteralPrimitive(ast: LiteralPrimitive) {}

  visitAccessMember(ast: AccessMember) {}

  visitSafeAccessMember(ast: SafeAccessMember) { this.simple = false; }

  visitMethodCall(ast: MethodCall) { this.simple = false; }

  visitSafeMethodCall(ast: SafeMethodCall) { this.simple = false; }

  visitFunctionCall(ast: FunctionCall) { this.simple = false; }

  visitLiteralArray(ast: LiteralArray) { this.visitAll(ast.expressions); }

  visitLiteralMap(ast: LiteralMap) { this.visitAll(ast.values); }

  visitBinary(ast: Binary) { this.simple = false; }

  visitPrefixNot(ast: PrefixNot) { this.simple = false; }

  visitConditional(ast: Conditional) { this.simple = false; }

  visitPipe(ast: BindingPipe) { this.simple = false; }

  visitKeyedAccess(ast: KeyedAccess) { this.simple = false; }

  visitAll(asts: List<any>): List<any> {
    var res = ListWrapper.createFixedSize(asts.length);
    for (var i = 0; i < asts.length; ++i) {
      res[i] = asts[i].visit(this);
    }
    return res;
  }

  visitChain(ast: Chain) { this.simple = false; }

  visitAssignment(ast: Assignment) { this.simple = false; }

  visitIf(ast: If) { this.simple = false; }
}
